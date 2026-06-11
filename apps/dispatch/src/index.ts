// Dispatch sidecar stub — milestone 1 placeholder.
// No Postgres, no MapLibre, no RapidPro until milestone 2.
// See design doc: apps/dispatch is scaffolded as an empty package in M1.

export interface CommsGateway {
  sendAlert(message: string): Promise<void>;
}

console.log("[dispatch] stub running — milestone 2 implementation pending");
