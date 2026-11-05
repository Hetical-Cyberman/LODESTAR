export type RequestKind = "transfer" | "add_key" | "delete_key";
export type RequestStatus = "pending" | "sent" | "denied";

export type GuardRequest = {
  id: string;
  kind: RequestKind;
  recipient: string;
  amount: string | null;
  status: RequestStatus;
  reason: string | null;
  anomalyScore: number;
  createdAt: string;
  updatedAt: string;
};

export type AuditEvent = {
  id: number;
  requestId: string | null;
  action: string;
  detail: string;
  createdAt: string;
};

export type GuardianSnapshot = {
  mode: "mock" | "testnet";
  accountId: string;
  balance: string;
  rules: {
    amountCap: number;
    burstLimit: number;
    burstWindowSeconds: number;
    anomalyZScore: number;
    allowlist: string[];
  };
  requests: GuardRequest[];
  audit: AuditEvent[];
};

export type NewRequestInput = {
  kind: RequestKind;
  recipient: string;
  amount?: string;
};
