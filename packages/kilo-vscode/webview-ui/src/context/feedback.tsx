/**
 * Feedback context
 *
 * Tracks per-message thumbs up/down ratings (held in memory for the life of
 * the webview) and the VS Code telemetry-enabled flag pushed by the extension
 * host. The context exposes a single `rate()` callback that updates the local
 * state and fires a telemetry event through the existing `telemetry` bridge.
 *
 * Payload rules (keep in sync with packages/kilo-telemetry/src/telemetry.ts):
 * - Non-Kilo-Gateway providers: providerID, modelID, variant, rating only —
 *   no session or message IDs, since they can't be correlated to upstream data.
 * - Kilo Gateway providers: add sessionID, messageID, parentMessageID. The
 *   gateway can join parentMessageID against its `x-kilo-request` header logs.
 */

import { createContext, useContext, createSignal, onCleanup, onMount } from "solid-js"
import type { ParentComponent, Accessor } from "solid-js"
import { useVSCode } from "./vscode"
import type { ExtensionMessage } from "../types/messages"
import { TelemetryEventName } from "../../../src/services/telemetry/types"

export type Rating = "up" | "down"

interface FeedbackContextValue {
  telemetryEnabled: Accessor<boolean>
  getRating: (messageID: string) => Rating | undefined
  rate: (input: RateInput) => void
}

export interface RateInput {
  messageID: string
  sessionID: string
  parentMessageID: string
  providerID: string
  modelID: string
  variant?: string
  next: Rating | null
}

const FeedbackContext = createContext<FeedbackContextValue>()

function isKiloGateway(providerID: string): boolean {
  return providerID.startsWith("kilo")
}

export const FeedbackProvider: ParentComponent = (props) => {
  const vscode = useVSCode()
  const [telemetryEnabled, setTelemetryEnabled] = createSignal(false)
  const [ratings, setRatings] = createSignal<Record<string, Rating>>({})

  const unsubscribe = vscode.onMessage((message: ExtensionMessage) => {
    if (message.type === "telemetryState") {
      setTelemetryEnabled(message.enabled)
    }
  })

  // Clear all ratings if telemetry flips from on to off — the user has revoked
  // consent, so any stored rating shouldn't continue to drive the UI.
  onMount(() => {
    let prev = telemetryEnabled()
    const unwatch = vscode.onMessage((message: ExtensionMessage) => {
      if (message.type !== "telemetryState") return
      if (prev && !message.enabled) setRatings({})
      prev = message.enabled
    })
    onCleanup(unwatch)
  })

  onCleanup(unsubscribe)

  const getRating = (messageID: string) => ratings()[messageID]

  const rate = (input: RateInput) => {
    if (!telemetryEnabled()) return
    const prev = ratings()[input.messageID]
    const next = input.next

    setRatings((current) => {
      const updated = { ...current }
      if (next === null) delete updated[input.messageID]
      else updated[input.messageID] = next
      return updated
    })

    const properties: Record<string, unknown> = {
      providerID: input.providerID,
      modelID: input.modelID,
      rating: next ?? "cleared",
    }
    if (input.variant) properties.variant = input.variant
    if (prev) properties.previousRating = prev
    if (isKiloGateway(input.providerID)) {
      properties.sessionID = input.sessionID
      properties.messageID = input.messageID
      properties.parentMessageID = input.parentMessageID
    }

    vscode.postMessage({
      type: "telemetry",
      event: TelemetryEventName.FEEDBACK_SUBMITTED,
      properties,
    })
  }

  const value: FeedbackContextValue = {
    telemetryEnabled,
    getRating,
    rate,
  }

  return <FeedbackContext.Provider value={value}>{props.children}</FeedbackContext.Provider>
}

export function useFeedback(): FeedbackContextValue {
  const context = useContext(FeedbackContext)
  if (!context) {
    throw new Error("useFeedback must be used within a FeedbackProvider")
  }
  return context
}
