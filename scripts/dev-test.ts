import { ethers } from "hardhat"

function feeOn(assets: bigint, bps: bigint, min: bigint) {
  const pct = (assets * bps) / 10_000n
  return pct < min ? min : pct
}

async function main() {
  const [deployer, user, feeRecipient] = await ethers.getSigners()
  console.log("Deployer:", await deployer.getAddress())
  console.log("User    :", await user.getAddress())
  console.log("FeeRecv :", await feeRecipient.getAddress())

  // Deploy Mock Multivault
  const Mock = await ethers.getContractFactory("contracts/MockEthMultiVault.sol:MockEthMultiVault")
  const multivault = await Mock.connect(deployer).deploy()
  await multivault.waitForDeployment()
  const multivaultAddr = await multivault.getAddress()
  console.log("MockEthMultiVault:", multivaultAddr)

  // Deploy forwarder
  const feeBps = 100 // 1%
  const minFeeWei = 10n
  const Fwd = await ethers.getContractFactory("contracts/MultivaultForwarder.sol:MultivaultForwarder")
  const forwarder = await Fwd.connect(deployer).deploy(
    multivaultAddr,
    await feeRecipient.getAddress(),
    feeBps,
    minFeeWei
  )
  await forwarder.waitForDeployment()
  const forwarderAddr = await forwarder.getAddress()
  console.log("Forwarder:", forwarderAddr)

  // Test depositAtomWithFeeExact
  const atomAssets = ethers.parseEther("0.50")
  const bps = BigInt(await forwarder.feeBps())
  const min = BigInt(await forwarder.minFeeWei())
  const atomFee = feeOn(atomAssets, bps, min)

  const balBeforeFee = await ethers.provider.getBalance(await feeRecipient.getAddress())
  const balBeforeMock = await ethers.provider.getBalance(multivaultAddr)

  const tx1 = await forwarder.connect(user).depositAtomWithFeeExact(
    await user.getAddress(), // receiver shares on the Multivault side
    1n,                      // vaultId arbitraire for the mock
    atomAssets,
    { value: atomAssets + atomFee }
  )
  const rc1 = await tx1.wait()
  console.log("depositAtom tx:", rc1?.hash)

  const balAfterFee = await ethers.provider.getBalance(await feeRecipient.getAddress())
  const balAfterMock = await ethers.provider.getBalance(multivaultAddr)

  console.log("Fee received (atom):", (balAfterFee - balBeforeFee).toString(), "wei")
  console.log("Mock received (atom):", (balAfterMock - balBeforeMock).toString(), "wei")

  // Test depositTripleWithFeeExact
  const tripleAssets = ethers.parseEther("0.30")
  const tripleFee = feeOn(tripleAssets, bps, min)

  const bal2BeforeFee = await ethers.provider.getBalance(await feeRecipient.getAddress())
  const bal2BeforeMock = await ethers.provider.getBalance(multivaultAddr)

  const tx2 = await forwarder.connect(user).depositTripleWithFeeExact(
    await user.getAddress(),
    42n,
    tripleAssets,
    { value: tripleAssets + tripleFee }
  )
  const rc2 = await tx2.wait()
  console.log("depositTriple tx:", rc2?.hash)

  const bal2AfterFee = await ethers.provider.getBalance(await feeRecipient.getAddress())
  const bal2AfterMock = await ethers.provider.getBalance(multivaultAddr)

  console.log("Fee received (triple):", (bal2AfterFee - bal2BeforeFee).toString(), "wei")
  console.log("Mock received (triple):", (bal2AfterMock - bal2BeforeMock).toString(), "wei")

  // Simple decoding of the FeesCollected events in the receipts
  const parseLogs = (logs: any[], tag: string) => {
    for (const l of logs) {
      try {
        const parsed = (forwarder as any).interface.parseLog(l)
        if (parsed?.name === "FeesCollected") {
          console.log(`[${tag}] FeesCollected -> payer=${parsed.args.payer}, op=${parsed.args.op}, amount=${parsed.args.amount}`)
        }
      } catch {}
    }
  }
  parseLogs(rc1!.logs, "ATOM")
  parseLogs(rc2!.logs, "TRIPLE")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
