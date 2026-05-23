import { setupWorker } from 'msw/browser'
import { handlers } from './handlers'
import { libsHandlers } from './libsHandlers'

export const worker = setupWorker(...handlers, ...libsHandlers)
