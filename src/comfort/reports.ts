import type Database from 'better-sqlite3'
import type { Side } from '@/src/hardware/types'
import {
  previewReportDetailSchema, previewReportListSchema, previewReviewInputSchema, previewReviewSchema,
  previewSummarySchema, reportIdSchema, type PreviewReportItem, type PreviewReview, type PreviewReviewInput,
} from './report-contract'
import { MAX_REPORT_ROWS, PreviewReportError, reportDigest, summarizePreview, type PreviewSourceRow } from './report-summary'

const MAX_REVIEWS_PER_SIDE = 1000
const REVIEW_RETENTION_MS = 180 * 86_400_000
interface ReviewRow { id: number, at: number, review: string, snapshot: string }

/** Owner review never changes settings, grants an activation lease or asserts sleep duration. */
export function createPreviewReports(database: Database.Database, clock = Date.now) {
  function now() {
    const at = clock()
    if (!Number.isSafeInteger(at) || at <= 0) throw new Error('Preview report clock is unavailable')
    return at
  }
  function source(side: Side, id: string): PreviewSourceRow[] {
    reportIdSchema.parse(id)
    return database.prepare(`SELECT id, observed_at AS at, event FROM comfort_events
      WHERE side = ? AND report_id = ? ORDER BY id LIMIT ?`).all(side, id, MAX_REPORT_ROWS + 1) as PreviewSourceRow[]
  }
  function latestReview(side: Side, id: string): ReviewRow | undefined {
    return database.prepare(`SELECT id, created_at AS at, review, snapshot FROM comfort_reviews
      WHERE side = ? AND report_id = ? AND created_at >= ? ORDER BY id DESC LIMIT 1`)
      .get(side, id, now() - REVIEW_RETENTION_MS) as ReviewRow | undefined
  }
  function decodeReview(row: ReviewRow | undefined): PreviewReview | null {
    return row ? previewReviewSchema.parse({ ...JSON.parse(row.review), id: row.id, at: row.at }) : null
  }
  async function load(side: Side, id: string, generatedAt: number) {
    const rows = source(side, id)
    const saved = latestReview(side, id)
    const review = decodeReview(saved)
    if (review && review.at > generatedAt) throw new PreviewReportError('The saved review is ahead of the current clock.', 'PRECONDITION_FAILED')
    const result = rows.length
      ? await summarizePreview(id, rows, generatedAt)
      : saved
        ? { summary: { ...previewSummarySchema.parse(JSON.parse(saved.snapshot)), state: 'source_expired' as const, reviewable: false,
            issues: ['Original journal source is no longer retained. This saved review cannot count toward current night evidence.'] }, observations: [] }
        : null
    if (!result) throw new PreviewReportError('Preview report not found for this side.', 'NOT_FOUND')
    const reviewCurrent = result.summary.state === 'closed' && review?.digest === result.summary.digest
    return { ...result, review, reviewCurrent,
      countsAsOwnerConfirmedNight: result.summary.reviewable && reviewCurrent
        && review?.outcome === 'reviewed' && review.confirmedActualNight === true }
  }

  return {
    async list(side: Side) {
      const generatedAt = now()
      const ids = database.prepare(`SELECT report_id AS id, MAX(at) AS latest FROM (
        SELECT report_id, observed_at AS at FROM comfort_events WHERE side = ? AND report_id IS NOT NULL
        UNION ALL SELECT report_id, created_at AS at FROM comfort_reviews WHERE side = ? AND created_at >= ?
      ) GROUP BY report_id ORDER BY latest DESC, report_id LIMIT 30`)
        .all(side, side, generatedAt - REVIEW_RETENTION_MS) as { id: string }[]
      const items: PreviewReportItem[] = []
      for (const { id } of ids) {
        const { summary, review, reviewCurrent, countsAsOwnerConfirmedNight } = await load(side, id, generatedAt)
        items.push({ summary, review, reviewCurrent, countsAsOwnerConfirmedNight })
      }
      // A timezone or routine edit cannot turn overlapping observations into two nights.
      const confirmed = items.filter(item => item.countsAsOwnerConfirmedNight).sort((first, second) => first.summary.metadata.start - second.summary.metadata.start)
      const dates = new Set<string>()
      let coveredUntil = 0
      let ownerConfirmedNights = 0
      for (const item of confirmed) {
        if (item.summary.metadata.start >= coveredUntil && !dates.has(item.summary.localDate)) ownerConfirmedNights++
        dates.add(item.summary.localDate)
        coveredUntil = Math.max(coveredUntil, item.summary.metadata.end)
      }
      return previewReportListSchema.parse({ apiVersion: 1, generatedAt, side, items,
        targetNights: 7, ownerConfirmedNights, activationAvailable: false })
    },

    async detail(side: Side, id: string, afterId = 0) {
      if (!Number.isSafeInteger(afterId) || afterId < 0) throw new PreviewReportError('Invalid observation cursor.', 'PRECONDITION_FAILED')
      const result = await load(side, id, now())
      const page = result.observations.filter(observation => observation.id > afterId).slice(0, 201)
      return previewReportDetailSchema.parse({ ...result, observations: page.slice(0, 200),
        nextAfterId: page.length > 200 ? page[199].id : null })
    },

    async review(input: PreviewReviewInput) {
      const request = previewReviewInputSchema.parse(input)
      const result = await load(request.side, request.id, now())
      if (result.summary.digest !== request.digest) throw new PreviewReportError('The report changed. Refresh and review its current observations.', 'CONFLICT')
      if (result.summary.state !== 'closed' || (request.outcome === 'reviewed' && !result.summary.reviewable)) {
        throw new PreviewReportError('This report is unfinished or lacks evidence for night confirmation. Inspect its issues first.', 'PRECONDITION_FAILED')
      }
      const saved = database.transaction(() => {
        const at = now()
        // Recheck the exact raw rows after yielding during parsing, before accepting a review.
        if (reportDigest(source(request.side, request.id)) !== request.digest) throw new PreviewReportError('The journal changed during review. Refresh the report.', 'CONFLICT')
        if (at < result.summary.metadata.end || at < result.summary.lastAt) throw new PreviewReportError('The report clock changed during review.', 'PRECONDITION_FAILED')
        const previous = decodeReview(latestReview(request.side, request.id))
        const value = { digest: request.digest, outcome: request.outcome, confirmedActualNight: request.confirmedActualNight, note: request.note }
        if (previous?.digest === value.digest && previous.outcome === value.outcome
          && previous.confirmedActualNight === value.confirmedActualNight && previous.note === value.note) return previous
        if ((previous?.id ?? null) !== request.expectedReviewId) throw new PreviewReportError('Another review was saved. Refresh before replacing its conclusion.', 'CONFLICT')
        const insert = database.prepare('INSERT INTO comfort_reviews (side, report_id, created_at, review, snapshot) VALUES (?, ?, ?, ?, ?)')
          .run(request.side, request.id, at, JSON.stringify(value), JSON.stringify(result.summary))
        database.prepare('DELETE FROM comfort_reviews WHERE created_at < ?').run(at - REVIEW_RETENTION_MS)
        database.prepare(`DELETE FROM comfort_reviews WHERE side = ? AND id NOT IN
          (SELECT id FROM comfort_reviews WHERE side = ? ORDER BY id DESC LIMIT ?)`)
          .run(request.side, request.side, MAX_REVIEWS_PER_SIDE)
        return previewReviewSchema.parse({ ...value, id: Number(insert.lastInsertRowid), at })
      })()
      return saved
    },
  }
}
