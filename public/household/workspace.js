// This workspace uses only person-scoped preparation endpoints. It never sends
// actuator commands, imports Health data, or falls back to legacy owner routes.
const element = id => document.getElementById(id)
let session = null
let preferences = null
let routines = null
let pending = null
let pendingKeySaved = false
let generation = 0
let busy = false
let invitationAttempt = null
const activeRequests = new Set()
const accountChannel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('sleepypod-account')
const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
function secret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}
// randomUUID is unavailable on some HTTP LAN origins; getRandomValues is not.
function identifier() {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const value = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}
function message(text, error = false) {
  element('message').textContent = text
  element('message').dataset.error = String(error)
}
async function request(path, method = 'GET', body, token, expectedSleeper = session?.selfSleeperId) {
  const requestGeneration = generation
  const controller = new AbortController()
  activeRequests.add(controller)
  const timeout = setTimeout(() => controller.abort(), 15000)
  try {
    let browserRevision = null
    if (method !== 'GET' && ['household/setup', 'household/join', 'household/session'].includes(path)) {
      const stateResponse = await fetch('/api/auth/session', { cache: 'no-store', signal: controller.signal })
      if (!stateResponse.ok) throw new Error('Browser account state is unavailable. Reconnect explicitly.')
      browserRevision = (await stateResponse.json()).browserScopeRevision
      if (requestGeneration !== generation) throw new Error('The browser account changed. Reload before continuing.')
    }
    const response = await fetch(`/api/v1/${path}`, {
      method, credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(expectedSleeper ? { 'X-Sleepypod-Sleeper-Id': expectedSleeper } : {}), ...(browserRevision ? { 'X-Sleepypod-Browser-Revision': browserRevision } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    const result = response.status === 204 ? null : await response.json()
    if (requestGeneration !== generation)
      throw new Error('The browser account changed. Reload before continuing.')
    if (!response.ok) {
      const error = new Error(result?.error?.message || 'The personal workspace is unavailable.')
      error.status = response.status
      throw error
    }
    return result
  }
  catch (error) {
    if (error.name === 'AbortError')
      throw new Error('The response was not confirmed. Check the connection before trying again.')
    throw error
  }
  finally {
    clearTimeout(timeout)
    activeRequests.delete(controller)
  }
}
async function action(operation) {
  if (busy)
    return
  busy = true
  document.querySelectorAll('button').forEach((button) => {
    button.disabled = true
  })
  try {
    await operation()
  }
  catch (error) {
    message(error.message, true)
  }
  finally {
    busy = false
    document.querySelectorAll('button').forEach((button) => {
      button.disabled = false
    })
  }
}
function context() {
  return { requestId: identifier(), expectedSessionRevision: session.sessionRevision, expectedAssignmentRevision: session.assignmentRevision }
}
function clearPersonalView() {
  generation += 1
  session = null
  preferences = null
  routines = null
  invitationAttempt = null
  element('workspace').hidden = true
  element('connect').hidden = false
  for (const name of ['device-list', 'invitation-list', 'draft-list', 'greeting', 'assignment'])
    element(name).replaceChildren()
  element('invitation-result').hidden = true
  element('invitation-link').value = ''
  element('preferences-form').reset()
  element('routine-form').reset()
}
function pendingConnection(value) {
  pending = value
  pendingKeySaved = false
  element('recovery').hidden = false
  element('recovery-key').value = value.deviceSecret
  element('recovery-key').type = 'password'
  element('show-key').textContent = 'Show key'
  message('First save your personal key privately. Then choose “I saved it privately” to finish joining.')
}
function addItem(parent, title, subtitle, buttonLabel, operation) {
  const row = document.createElement('div')
  row.className = 'item'
  const heading = document.createElement('strong')
  heading.textContent = title
  row.append(heading)
  const paragraph = document.createElement('p')
  paragraph.textContent = subtitle
  row.append(paragraph)
  if (buttonLabel && operation) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = buttonLabel
    button.addEventListener('click', () => action(operation))
    row.append(button)
  }
  parent.append(row)
}
async function refresh() {
  const currentGeneration = ++generation
  const currentSession = await request('household/session')
  const readPersonal = path => request(path, 'GET', undefined, undefined, currentSession.selfSleeperId)
  const results = await Promise.all([
    readPersonal('me/preferences'), readPersonal('me/routines'), readPersonal('household/devices'), readPersonal('household/invitations'),
  ])
  if (currentGeneration !== generation)
    return
  if (results[0].sleeperId !== currentSession.selfSleeperId || results[1].sleeperId !== currentSession.selfSleeperId)
    throw new Error('The personal account changed. Reconnect before continuing.')
  if (results[1].status !== 'draft_only') {
    clearPersonalView()
    throw new Error('Update the personal app before editing an active routine. This preparation workspace can edit drafts only.')
  }
  session = currentSession;
  [preferences, routines] = results
  element('connect').hidden = true
  element('workspace').hidden = false
  element('greeting').textContent = `Hello, ${session.self.displayName}.`
  element('assignment').textContent = session.self.assignment === 'solo' ? 'Sole current sleeper · either side · personal preparation workspace' : 'Your account is ready to prepare · no active bed side assigned yet'
  element('preference-temperature').value = preferences.preferences.preferredTemperatureF
  element('comfort').value = preferences.preferences.comfort
  element('display-unit').value = preferences.preferences.displayUnit
  element('share-wake').checked = preferences.preferences.shareWakeTime
  element('partner-option').hidden = session.role !== 'owner'
  if (session.role !== 'owner')
    element('invite-kind').value = 'own_device'
  element('invitation-help').textContent = session.role === 'owner' ? 'Invite a second person, or pair another device with your own account. Neither action changes the active bed arrangement.' : 'Pair another device with your own account. Your partner has a separate invitation and account.'
  element('device-list').replaceChildren()
  for (const device of results[2].devices)
    addItem(element('device-list'), device.name, device.current ? 'This connection' : 'Personal device', results[2].devices.length > 1 ? 'Remove this device' : null, async () => {
      if (!confirm(`Remove ${device.name}? Its personal connection will stop.`))
        return
      await request('household/devices', 'DELETE', { ...context(), deviceId: device.id })
      if (device.current) {
        clearPersonalView()
        message('This personal device was removed. Reconnect with another authorized personal key.')
      }
      else {
        await refresh()
        message('Personal device removed.')
      }
    })
  element('invitation-list').replaceChildren()
  for (const invitation of results[3].invitations)
    addItem(element('invitation-list'), invitation.kind === 'new_person' ? 'Second-person invitation' : 'Own-device invitation', `${invitation.status} · expires ${new Date(invitation.expiresAt).toLocaleString()}`, invitation.status === 'pending' ? 'Revoke invitation' : null, async () => {
      await request('household/invitations', 'DELETE', { ...context(), invitationId: invitation.id })
      element('invitation-result').hidden = true
      element('invitation-link').value = ''
      await refresh()
      message('Invitation revoked.')
    })
  element('draft-list').replaceChildren()
  for (const routine of routines.routines)
    addItem(element('draft-list'), `${routine.dayOfWeek} night`, `${routine.draft.power.onTime} bedtime · ${routine.draft.alarm?.time ?? 'no alarm'} wake · draft only`)
  loadDraft()
}
function loadDraft() {
  const found = routines?.routines.find(routine => routine.dayOfWeek === element('routine-day').value)
  const draft = found?.draft
  element('routine-bed').value = draft?.power.onTime ?? '22:00'
  element('routine-wake').value = draft?.alarm?.time ?? draft?.power.offTime ?? '07:30'
  element('routine-temperature').value = draft?.power.onTemperature ?? preferences?.preferences.preferredTemperatureF ?? 76
  element('routine-warm').value = draft?.alarm?.alarmTemperature ?? 82
  element('routine-vibrate').checked = draft?.alarm?.enabled ?? true
  summarizeRoutine()
}
function summarizeRoutine() {
  const bedtime = element('routine-bed').value, wake = element('routine-wake').value
  const day = element('routine-day').value
  const morning = days[(days.indexOf(day) + Number(wake <= bedtime)) % 7]
  element('routine-summary').textContent = `${day} ${bedtime} → ${morning} ${wake}. Draft only; no real alarm is scheduled.`
}
async function finishPendingConnection() {
  if (!pending || !pendingKeySaved)
    throw new Error('Save your personal key before creating the connection.')
  const input = { ...pending }
  delete input.kind
  await request(`household/${pending.kind}`, 'POST', input, pending.kind === 'setup' ? element('owner-key').value.trim() : undefined)
  element('owner-key').value = ''
  element('join-form').reset()
  element('setup-form').reset()
  announceAccountChange()
  await refresh()
  pending = null
  element('recovery-key').value = ''
  element('recovery').hidden = true
  message('Your private preparation workspace is connected. Existing routines, history and bed arrangement were not changed.')
}
element('join-form').addEventListener('submit', (event) => {
  event.preventDefault()
  action(async () => {
    if (!pending) {
      pendingConnection({ kind: 'join', deviceSecret: secret(), invitation: element('invite').value.trim(), displayName: element('name').value.trim(), deviceName: element('device-name').value.trim() })
      return
    }
    if (pending.kind !== 'join')
      throw new Error('Finish or recover the pending connection first.')
    await finishPendingConnection()
  })
})
element('setup-form').addEventListener('submit', (event) => {
  event.preventDefault()
  action(async () => {
    if (!pending) {
      pendingConnection({ kind: 'setup', requestId: identifier(), deviceSecret: secret(), deviceName: 'Owner browser', displayName: element('owner-name').value.trim(), currentMode: 'solo-anywhere', sourceSide: element('source-side').value, acknowledgeExistingOwner: true })
      return
    }
    if (pending.kind !== 'setup')
      throw new Error('Finish or recover the pending connection first.')
    await finishPendingConnection()
  })
})
element('login-form').addEventListener('submit', (event) => {
  event.preventDefault()
  action(async () => {
    clearPersonalView()
    await request('household/session', 'POST', { token: element('personal-key').value.trim() })
    element('personal-key').value = ''
    announceAccountChange()
    await refresh()
    message('Your personal account is connected.')
  })
})
element('reconcile').addEventListener('click', () => action(async () => {
  if (!pending)
    return
  await request('household/session', 'POST', { token: pending.deviceSecret })
  announceAccountChange()
  await refresh()
  message('The retained personal key connected successfully. No second account was created.')
}))
element('show-key').addEventListener('click', () => {
  const hidden = element('recovery-key').type === 'password'
  element('recovery-key').type = hidden ? 'text' : 'password'
  element('show-key').textContent = hidden ? 'Hide key' : 'Show key'
})
async function copyField(id) {
  const input = element(id)
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(input.value)
      message('Copied. Save or share it privately.')
      return
    }
    catch { /* HTTP LAN origins can require manual copy. */ }
  }
  input.type = 'text'
  input.focus()
  input.select()
  message('The private value is selected. Use Copy, then save or share it privately.')
}
element('copy-key').addEventListener('click', () => copyField('recovery-key'))
element('copy-invitation').addEventListener('click', () => copyField('invitation-link'))
element('saved-key').addEventListener('click', () => {
  if (pending && !session) {
    pendingKeySaved = true
    action(finishPendingConnection)
    return
  }
  pending = null
  element('recovery-key').value = ''
  element('recovery').hidden = true
})
element('preferences-form').addEventListener('submit', (event) => {
  event.preventDefault()
  action(async () => {
    const result = await request('me/preferences', 'PUT', { ...context(), expectedRevision: preferences.revision, preferences: { displayUnit: element('display-unit').value, preferredTemperatureF: Number(element('preference-temperature').value), comfort: element('comfort').value, shareWakeTime: element('share-wake').checked, cloudAnalysisConsent: false } })
    if (result.sleeperId !== session.selfSleeperId)
      throw new Error('The personal account changed. Reload before continuing.')
    preferences = result
    message('Your private preferences were saved. The bed target was not changed.')
  })
})
element('routine-form').addEventListener('submit', (event) => {
  event.preventDefault()
  action(async () => {
    const day = element('routine-day').value
    const existing = routines.routines.find(routine => routine.dayOfWeek === day)
    if (existing && (existing.draft.temperatures.length > 0 || existing.draft.notes || existing.draft.power.endAction !== 'turn_off' || !existing.draft.power.enabled || (existing.draft.alarm && existing.draft.power.offTime !== existing.draft.alarm.time)))
      throw new Error('This draft has additional phases or notes. Use the full editor to preserve them.')
    const replacement = { dayOfWeek: day, draft: { power: { onTime: element('routine-bed').value, offTime: element('routine-wake').value, onTemperature: Number(element('routine-temperature').value), enabled: true, endAction: 'turn_off' }, temperatures: [], alarm: { ...(existing?.draft.alarm ?? { vibrationIntensity: 40, vibrationPattern: 'rise', duration: 20, wakeWindow: 0 }), time: element('routine-wake').value, alarmTemperature: Number(element('routine-warm').value), enabled: element('routine-vibrate').checked }, notes: '' } }
    const week = [...routines.routines.filter(routine => routine.dayOfWeek !== day), replacement]
    await request('me/routines', 'PUT', { ...context(), expectedRevision: routines.revision, routines: week })
    await refresh()
    message('Your night was saved as a private draft. No real bed routine or alarm changed.')
  })
})
element('routine-day').addEventListener('change', loadDraft)
for (const id of ['routine-bed', 'routine-wake'])
  element(id).addEventListener('change', summarizeRoutine)
element('invitation-form').addEventListener('submit', (event) => {
  event.preventDefault()
  action(async () => {
    invitationAttempt ??= { ...context(), invitation: secret(), kind: element('invite-kind').value, expiresInMinutes: 30 }
    const result = await request('household/invitations', 'POST', invitationAttempt)
    invitationAttempt = null
    element('invitation-link').value = `${location.origin}/household/index.html#invite=${encodeURIComponent(result.invitation)}`
    element('invitation-result').hidden = false
    await refresh()
    message('A private invitation is ready. Share it only with its intended recipient.')
  })
})
element('logout').addEventListener('click', () => action(async () => {
  clearPersonalView()
  pending = null
  element('recovery-key').value = ''
  element('recovery').hidden = true
  await request('household/session', 'DELETE')
  announceAccountChange()
  message('Signed out of the personal workspace in this browser. The bed continues its existing routines.')
}))
function announceAccountChange() {
  accountChannel?.postMessage('personal-account-changed')
  try {
    localStorage.setItem('sleepypod-account-change', `${Date.now()}:personal`)
  }
  catch { /* No personal information is kept in browser storage. */ }
}
function otherAccountChanged() {
  for (const controller of activeRequests)
    controller.abort()
  clearPersonalView()
  pending = null
  element('recovery-key').value = ''
  element('recovery').hidden = true
  element('personal-key').value = ''
  element('owner-key').value = ''
  message('The account changed in another tab. Reload to confirm the current personal connection.')
}
if (accountChannel)
  accountChannel.onmessage = otherAccountChanged
window.addEventListener('storage', (event) => {
  if (event.key === 'sleepypod-account-change')
    otherAccountChanged()
})
window.addEventListener('pagehide', () => {
  for (const controller of activeRequests)
    controller.abort()
})
window.addEventListener('focus', async () => {
  if (!session || busy) return
  try {
    await request('household/session')
  }
  catch (error) {
    if ([401, 409].includes(error.status)) otherAccountChanged()
  }
})
const inviteInFragment = new URLSearchParams(location.hash.slice(1)).get('invite')
if (inviteInFragment) {
  element('invite').value = inviteInFragment
  history.replaceState(null, '', location.pathname)
  element('connect').hidden = false
  message('A personal invitation is ready. Enter your name and device name to join.')
}
else {
  action(async () => {
    try {
      await refresh()
      message('Your private preparation workspace is connected.')
    }
    catch (error) {
      clearPersonalView()
      message(error.status === 401 ? 'Join with an invitation or reconnect your personal account.' : error.message, error.status !== 401)
    }
  })
}
