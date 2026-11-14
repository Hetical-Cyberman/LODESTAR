use near_workspaces::types::NearToken;
use serde_json::json;

const WASM_FILEPATH: &str = "./target/wasm32-unknown-unknown/release/guardian_policy.wasm";

#[tokio::test]
async fn test_full_onchain_guardian_lifecycle() -> anyhow::Result<()> {
    // 1. Spin up a local NEAR sandbox network
    let worker = near_workspaces::sandbox().await?;
    let wasm = std::fs::read(WASM_FILEPATH)?;
    let contract = worker.dev_deploy(&wasm).await?;

    // 2. Create test accounts: Owner, Guardian Agent, Trusted Vendor, Unknown Attacker
    let owner = worker.dev_create_account().await?;
    let guardian = worker.dev_create_account().await?;
    let trusted_vendor = worker.dev_create_account().await?;
    let unknown_recipient = worker.dev_create_account().await?;

    println!("Deployed contract to: {}", contract.id());
    println!("Owner: {}", owner.id());
    println!("Guardian: {}", guardian.id());

    // 3. Initialize Policy Contract with 5 NEAR cap
    contract
        .call("new")
        .args_json(json!({
            "owner_id": owner.id(),
            "guardian_id": guardian.id(),
            "amount_cap_near": 5
        }))
        .transact()
        .await?
        .into_result()?;

    // 4. Fund the contract with 20 NEAR so it can execute guarded transfers
    owner
        .transfer_near(contract.id(), NearToken::from_near(20))
        .await?
        .into_result()?;

    // 5. Add trusted_vendor to allowlist
    owner
        .call(contract.id(), "add_allowlist")
        .args_json(json!({ "account_id": trusted_vendor.id() }))
        .transact()
        .await?
        .into_result()?;

    // -------------------------------------------------------------
    // SCENARIO 1: Normal payment (1 NEAR to trusted_vendor)
    // The initial call must report Processing; the callback changes it to Executed only after transfer success.
    // -------------------------------------------------------------
    println!("\n--- SCENARIO 1: Normal Allowlisted Payment (1 NEAR) ---");
    let initial_vendor_bal = trusted_vendor.view_account().await?.balance;
    let res1 = guardian
        .call(contract.id(), "request_transfer")
        .args_json(json!({
            "recipient": trusted_vendor.id(),
            "amount": NearToken::from_near(1).as_yoctonear().to_string()
        }))
        .max_gas()
        .transact()
        .await?
        .json::<serde_json::Value>()?;

    println!("Request result: {:?}", res1);
    assert_eq!(res1["status"], "Processing");

    let req1_id = res1["id"].as_u64().unwrap();
    let mut safe_final = serde_json::Value::Null;
    for _ in 0..40 {
        safe_final = contract.view("get_request").args_json(json!({ "request_id": req1_id })).await?.json()?;
        if safe_final["status"] != "Processing" { break; }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    assert_eq!(safe_final["status"], "Executed");

    let final_vendor_bal = trusted_vendor.view_account().await?.balance;
    assert!(final_vendor_bal > initial_vendor_bal);
    println!("✓ Normal payment executed automatically on-chain!");

    // -------------------------------------------------------------
    // SCENARIO 2: Attack / Unknown Recipient (1 NEAR to unknown account)
    // Expectation: HELD. Status = Pending. Funds NOT sent.
    // -------------------------------------------------------------
    println!("\n--- SCENARIO 2: Unknown Recipient (Held) ---");
    let res2 = guardian
        .call(contract.id(), "request_transfer")
        .args_json(json!({
            "recipient": unknown_recipient.id(),
            "amount": NearToken::from_near(1).as_yoctonear().to_string()
        }))
        .max_gas()
        .transact()
        .await?
        .json::<serde_json::Value>()?;

    println!("Request result: {:?}", res2);
    assert_eq!(res2["status"], "Pending");
    assert!(res2["reason"].as_str().unwrap().contains("allowlist"));
    let req2_id = res2["id"].as_u64().unwrap();

    // Check pending queue
    let pending: Vec<serde_json::Value> = contract
        .view("get_pending_requests")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(pending.len(), 1);
    println!("✓ Transfer to unknown recipient caught and locked in pending queue!");

    // -------------------------------------------------------------
    // SCENARIO 3: Owner Approves Held Request #2
    // Expectation: Owner signs approve_request -> funds released to recipient.
    // -------------------------------------------------------------
    println!("\n--- SCENARIO 3: Owner Approves Held Request ---");
    let init_unknown_bal = unknown_recipient.view_account().await?.balance;

    let approve_res = owner
        .call(contract.id(), "approve_request")
        .args_json(json!({ "request_id": req2_id }))
        .max_gas()
        .transact()
        .await?
        .json::<serde_json::Value>()?;

    assert_eq!(approve_res["status"], "Processing");

    let mut approved_final = serde_json::Value::Null;
    for _ in 0..40 {
        approved_final = contract.view("get_request").args_json(json!({ "request_id": req2_id })).await?.json()?;
        if approved_final["status"] != "Processing" { break; }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    assert_eq!(approved_final["status"], "Executed");
    let final_unknown_bal = unknown_recipient.view_account().await?.balance;
    assert!(final_unknown_bal > init_unknown_bal);
    println!("✓ Owner approved request. Funds successfully released on-chain!");

    // Verify pending queue is now empty
    let pending_after: Vec<serde_json::Value> = contract
        .view("get_pending_requests")
        .args_json(json!({}))
        .await?
        .json()?;
    assert_eq!(pending_after.len(), 0);
    println!("✓ Queue cleared.");

    // An underfunded contract must record Failed, never Approved/Executed.
    let failed_request = guardian
        .call(contract.id(), "request_transfer")
        .args_json(json!({
            "recipient": unknown_recipient.id(),
            "amount": NearToken::from_near(100).as_yoctonear().to_string()
        }))
        .max_gas()
        .transact()
        .await?
        .json::<serde_json::Value>()?;
    let failed_id = failed_request["id"].as_u64().unwrap();
    let failed_approval = owner
        .call(contract.id(), "approve_request")
        .args_json(json!({ "request_id": failed_id }))
        .max_gas()
        .transact()
        .await?
        .json::<serde_json::Value>()?;
    assert_eq!(failed_approval["status"], "Processing");
    let mut failed_final = serde_json::Value::Null;
    for _ in 0..40 {
        failed_final = contract.view("get_request").args_json(json!({ "request_id": failed_id })).await?.json()?;
        if failed_final["status"] != "Processing" { break; }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    assert_eq!(failed_final["status"], "Failed");

    println!("\n All on-chain policy scenarios passed successfully!");
    Ok(())
}
