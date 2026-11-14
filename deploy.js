// Kept under its old filename for compatibility. This script is read-only:
// it verifies the already deployed policy and never creates keys or broadcasts transactions.
const { JsonRpcProvider } = require("near-api-js");

async function main() {
  const contractId = process.env.POLICY_CONTRACT_ID || "guardian-policy-482207.testnet";
  const rpcUrl = process.env.NEAR_RPC_URL || "https://rpc.testnet.near.org";
  const provider = new JsonRpcProvider({ url: rpcUrl });
  const raw = await provider.query({
    request_type: "call_function",
    finality: "final",
    account_id: contractId,
    method_name: "get_policy",
    args_base64: "",
  });
  const policy = JSON.parse(Buffer.from(raw.result).toString("utf8"));
  console.log(`Policy contract: ${contractId}`);
  console.log(`Owner: ${policy.owner_id}`);
  console.log(`Guardian: ${policy.guardian_id}`);
  console.log(`Amount cap (yoctoNEAR): ${policy.amount_cap}`);
  console.log("Read-only check complete. No key material was read or saved.");
}

main().catch((error) => {
  console.error("Policy contract check failed:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
