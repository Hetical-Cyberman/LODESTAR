const { Account, JsonRpcProvider, nearToYocto } = require("near-api-js");
const fs = require("fs");
const path = require("path");

async function main() {
  const deployment = JSON.parse(fs.readFileSync(path.resolve(__dirname, "deployment-testnet.json"), "utf8"));
  const provider = new JsonRpcProvider({ url: "https://rpc.testnet.near.org" });
  
  // Use guardian account keypair created during deployment
  const guardianAccount = new Account(deployment.contractAccountId, provider, deployment.privateKey);

  console.log("==================================================================");
  console.log("RUNNING LIVE ON-CHAIN ATTACK SIMULATION ON NEAR TESTNET");
  console.log(`Target Contract: ${deployment.contractAccountId}`);
  console.log(`Configured Owner: ${deployment.ownerAccountId}`);
  console.log("==================================================================\n");

  // Attack Scenario: Attacker tries to transfer 10 NEAR (above 5 NEAR cap) to an unknown address
  const suspiciousRecipient = "unknown-hacker.testnet";
  const amountNear = "10";
  console.log(`[ATTACK TRIGGERED]: Attempting unauthorized transfer of ${amountNear} NEAR to '${suspiciousRecipient}'...`);

  const outcome = await guardianAccount.callFunctionRaw({
    contractId: deployment.contractAccountId,
    methodName: "request_transfer",
    args: {
      recipient: suspiciousRecipient,
      amount: nearToYocto(amountNear).toString(),
    },
    gas: BigInt("30000000000000"),
    deposit: BigInt(0),
  });

  console.log(`✓ Transaction broadcasted! Tx Hash: ${outcome.transaction?.hash}`);

  // Query on-chain pending requests from the contract
  console.log("\n[QUERYING ON-CHAIN QUEUE]: Fetching pending requests from smart contract...");
  const queryResult = await provider.query({
    request_type: "call_function",
    finality: "final",
    account_id: deployment.contractAccountId,
    method_name: "get_pending_requests",
    args_base64: "",
  });

  const pendingList = JSON.parse(Buffer.from(queryResult.result).toString());
  console.log("\n==================================================================");
  console.log("ON-CHAIN PENDING QUEUE RESULT:");
  console.log(JSON.stringify(pendingList, null, 2));
  console.log("==================================================================");

  if (pendingList.length > 0 && pendingList[0].status === "Pending") {
    console.log(`\n🎉 SUCCESS! The transaction was INTERCEPTED & HELD ON-CHAIN!`);
    console.log(`Request ID: #${pendingList[0].id}`);
    console.log(`Recipient: ${pendingList[0].recipient}`);
    console.log(`Status: ${pendingList[0].status}`);
    console.log(`Enforcement Reason: "${pendingList[0].reason}"`);
    console.log(`Funds were NOT sent. They are waiting for owner (${deployment.ownerAccountId}) approval!`);
  }
}

main().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
