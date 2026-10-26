import { sqlite } from '@/src/db'
import { createRoomContextStore } from './store'
const globals = globalThis as typeof globalThis & { __sp_roomContext?: ReturnType<typeof createRoomContextStore> }
export function getRoomContext() {
  return globals.__sp_roomContext ??= createRoomContextStore(sqlite)
}
export function getRoomContextIfRunning() {
  return globals.__sp_roomContext ?? null
}
export class RoomSignalReader {
  read() { return getRoomContext().signals() }
}
