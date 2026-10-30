import { createRoot } from 'react-dom/client'
import { householdSessionSchema, type HouseholdSession } from '../contract'
import { PersonalBrowserClient } from './client'
import { BrowserRecoveryJournal } from './recovery'
import { PersonalWebWorkspace } from './workspace'
import { PersonalWorkspace } from './PersonalWorkspace'
import { PersonalHistoryWorkspace } from './history'
export { BrowserRecoveryJournal } from './recovery'
export { contextKey } from './protocol'
/** Mounted outside the owner application: no owner provider, transport or stream. */
export function mountPersonalWorkspace(element: HTMLElement, input: HouseholdSession, preferences: {
  preferredTemperatureF: number
  displayUnit: 'F' | 'C'
}, invalidated: () => void) {
  const session = householdSessionSchema.parse(input)
  const root = createRoot(element)
  const invalidate = () => {
    workspace.dispose()
    history.dispose()
    invalidated()
  }
  const workspace = new PersonalWebWorkspace({ session, client: new PersonalBrowserClient(session), journal: new BrowserRecoveryJournal(), invalidated: invalidate })
  const history = new PersonalHistoryWorkspace({ session, client: new PersonalBrowserClient(session), invalidated: invalidate })
  const render = (value: typeof preferences) => root.render(<PersonalWorkspace workspace={workspace} history={history} {...value} />)
  render(preferences)
  void workspace.start()
  const polling = setInterval(() => {
    if (document.visibilityState === 'visible')
      void workspace.refresh()
  }, 5000)
  const freshness = setInterval(() => workspace.tick(), 1000)
  // Never restore a private recording page from a backgrounded account view.
  const hideHistory = () => {
    if (document.visibilityState !== 'visible') history.clear()
  }
  document.addEventListener('visibilitychange', hideHistory)
  const historyAccess = setInterval(() => {
    if (document.visibilityState === 'visible') void history.checkAccess()
  }, 15000)
  return { updatePreferences: render, dispose() {
    clearInterval(polling)
    clearInterval(freshness)
    clearInterval(historyAccess)
    document.removeEventListener('visibilitychange', hideHistory)
    workspace.dispose()
    history.dispose()
    root.unmount()
  } }
}
