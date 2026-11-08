const { KeyPair, JsonRpcProvider, Account } = require("near-api-js");
const https = require("https");
const fs = require("fs");
const path = require("path");

async function main() {
  const timestamp = Date.now().toString().slice(-6);
  const contractAccountId = `guardian-policy-${timestamp}.testnet`;
  console.log(`1. Generating keypair for new testnet contract account: ${contractAccountId}...`);
  
  const keyPair = KeyPair.fromRandom("ed25519");
  const publicKey = keyPair.getPublicKey().toString();
  const privateKey = keyPair.toString();
  
  console.log(`Public Key: ${publicKey}`);
  
  // Call NEAR testnet helper to create and fund the account with testnet NEAR
  console.log(`2. Requesting testnet account creation from testnet helper...`);
  const postData = JSON.stringify({
    newAccountId: contractAccountId,
    newAccountPublicKey: publicKey
  });

  const reqOptions = {
    hostname: 'helper.testnet.near.org',
    port: 443,
    path: '/account',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  await new Promise((resolve, reject) => {
    const req = https.request(reqOptions, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`Account ${contractAccountId} created successfully!`);
          resolve(body);
        } else {
          console.error(`Creation failed with code ${res.statusCode}:`, body);
          reject(new Error(`Failed to create account: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });

  // Now deploy the WASM
  console.log(`3. Deploying compiled WASM binary...`);
  const wasmPath = path.resolve(__dirname, "contracts/guardian-policy/target/wasm32-unknown-unknown/release/guardian_policy.wasm");
  const wasmBytes = fs.readFileSync(wasmPath);
  console.log(`WASM size: ${(wasmBytes.length / 1024).toFixed(1)} KB`);

  const provider = new JsonRpcProvider({ url: "https://rpc.testnet.near.org" });
  const account = new Account(contractAccountId, provider, privateKey);

  // Deploy contract
  const deployResult = await account.deployContract(wasmBytes);
  console.log(`Contract deployed! Tx Hash: ${deployResult.transaction.hash}`);

  // Initialize contract with wisejaguar3455.testnet as owner
  console.log(`4. Initializing contract with owner: wisejaguar3455.testnet...`);
  const initResult = await account.callFunctionRaw({
    contractId: contractAccountId,
    methodName: "new",
    args: {
      owner_id: "wisejaguar3455.testnet",
      guardian_id: contractAccountId,
      amount_cap_near: 5
    },
    gas: BigInt("30000000000000"),
    deposit: BigInt(0)
  });
  console.log(`Contract initialized! Tx Hash: ${initResult.transaction.hash}`);

  console.log("\n==========================================");
  console.log("DEPLOYMENT COMPLETE!");
  console.log(`Contract Account ID: ${contractAccountId}`);
  console.log(`Owner Account ID: wisejaguar3455.testnet`);
  console.log("==========================================");

  // Save info to a local json file for reference
  const deploymentInfo = {
    contractAccountId,
    ownerAccountId: "wisejaguar3455.testnet",
    publicKey,
    privateKey,
    deployedAt: new Date().toISOString()
  };
  fs.writeFileSync(path.resolve(__dirname, "deployment-testnet.json"), JSON.stringify(deploymentInfo, null, 2));
  console.log("Saved deployment metadata to deployment-testnet.json");
}

main().catch(err => {
  console.error("Deployment failed:", err);
  process.exit(1);
});
