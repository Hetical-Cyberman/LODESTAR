export type RequestKind = "transfer" | "add_key" | "delete_key";
export type RequestStatus = "pending" | "processing" | "sent" | "denied" | "failed";

export type GuardRequest = {
  id: string;
  kind: RequestKind;
  recipient: string;
  amount: string | null;
  status: RequestStatus;
  reason: string | null;
  anomalyScore: number;
  transactionHash?: string | null;
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
  ownerAccountId?: string;
  guardianAccountId?: string;
  contractGuardianId?: string;
  contractVersion?: string | null;
  callbackReady?: boolean;
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
  setupError?: string;
  history?: { recipient: string; amount: number }[];
  historyCount?: number;
  knownRecipients?: string[];
};

export type NewRequestInput = {
  kind: RequestKind;
  recipient: string;
  amount?: string;
};
