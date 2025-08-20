// scripts/fork-test-multivault.ts
import { ethers } from "hardhat"
import "dotenv/config"

const MULTIVAULT = "0x1A6950807E33d5bC9975067e6D6b5Ea4cD661665" as const
const ATOM_VAULT_ID = process.env.ATOM_VAULT_ID ? BigInt(process.env.ATOM_VAULT_ID) : null
const TRIPLE_VAULT_ID = process.env.TRIPLE_VAULT_ID ? BigInt(process.env.TRIPLE_VAULT_ID) : null

// ---- ABIs minimales ----
const EthMultiVaultAbi = [
  // events (pour le parsing)
  "event Deposited(uint256 indexed vaultId, address indexed receiver, uint256 sharesForReceiver, uint256 assets, uint256 entryFee)",

  // writes (payable)
  "function depositAtom(address receiver, uint256 vaultId) external payable",
  "function depositTriple(address receiver, uint256 vaultId) external payable",

  // read (optionnel: minDeposit)
  "function generalConfig() view returns (address admin, address protocolVault, uint256 feeDenominator, uint256 minDeposit, uint256 minShare, uint256 atomUriMaxLength, uint256 decimalPrecision, uint256 minDelay)"
] as const

const ForwarderAbi = [
  "function feeBps() view returns (uint96)",
  "function minFeeWei() view returns (uint256)",
  "function quoteFee(uint256 assets, address payer) view returns (uint256)",
  "function depositAtomWithFeeExact(address receiver, uint256 vaultId, uint256 assets) payable",
  "function depositTripleWithFeeExact(address receiver, uint256 vaultId, uint256 assets) payable",
  "event FeesCollected(address indexed payer, bytes4 indexed op, uint256 amount)"
] as const

async function main() {
  const [deployer, user, feeRecipient] = await ethers.getSigners()
  const deployerAddr = await deployer.getAddress()
  const userAddr = await user.getAddress()
  const feeRecipientAddr = await feeRecipient.getAddress()

  console.log("Deployer:", deployerAddr)
  console.log("User    :", userAddr)
  console.log("FeeRecv :", feeRecipientAddr)

  if (!ATOM_VAULT_ID) {
    console.log("❗ ATOM_VAULT_ID non défini. Renseigne un vaultId d'atome valide dans .env")
    return
  }

  // Instancie le Multivault (lecture uniquement ici)
  const multivault = new ethers.Contract(MULTIVAULT, EthMultiVaultAbi, ethers.provider)

  // (optionnel) lecture minDeposit
  let minDeposit: bigint = 0n
  try {
    const cfg = await (multivault.connect(deployer) as any).generalConfig()
    // cfg[3] = minDeposit
    minDeposit = BigInt(cfg[3])
  } catch {
    // certaines versions n'exposent pas generalConfig
  }
  console.log("minDeposit (si dispo):", minDeposit.toString())

  // ---- Déploiement du forwarder ----
  const feeBpsInit = 100 // 1%
  const minFeeWeiInit = 0n
  const Fwd = await ethers.getContractFactory("contracts/MultivaultForwarder.sol:MultivaultForwarder")
  const forwarder = await Fwd.connect(deployer).deploy(
    MULTIVAULT,
    feeRecipientAddr,
    feeBpsInit,
    minFeeWeiInit
  )
  await forwarder.waitForDeployment()
  const forwarderAddr = await forwarder.getAddress()
  console.log("Forwarder:", forwarderAddr)

  const forwarderRO = new ethers.Contract(forwarderAddr, ForwarderAbi, ethers.provider)

  const currentBps: bigint = BigInt(await forwarderRO.feeBps())
  const currentMin: bigint = BigInt(await forwarderRO.minFeeWei())
  console.log("feeBps/minFeeWei:", currentBps.toString(), "/", currentMin.toString())

  // ---- Helper parsing event ----
  const ifaceMV = new ethers.Interface(EthMultiVaultAbi)
  const parseDeposited = (logs: any[]) => {
    for (const l of logs) {
      if (l.address?.toLowerCase?.() === MULTIVAULT.toLowerCase()) {
        try {
          const ev = ifaceMV.parseLog(l)
          if (ev?.name === "Deposited") {
            console.log(
              "MV.Deposited →",
              "vaultId:", ev.args.vaultId.toString(),
              "receiver:", ev.args.receiver,
              "assets:", ev.args.assets.toString(),
              "entryFee:", ev.args.entryFee.toString(),
              "sharesForReceiver:", ev.args.sharesForReceiver.toString()
            )
          }
        } catch {}
      }
    }
  }

  // ---- Dépôt ATOM ----
  const assetsAtom = minDeposit > 0n ? minDeposit : ethers.parseEther("0.01")

  // 1) Quote fee on-chain (prend en compte exemption NFT si active)
  const feeAtom: bigint = await forwarderRO.quoteFee(assetsAtom, userAddr)
  const valueAtom = assetsAtom + feeAtom
  console.log("assetsAtom:", assetsAtom.toString(), "feeAtom:", feeAtom.toString(), "total value:", valueAtom.toString())

  // 1.bis) Test volontaire d'erreur si msg.value incorrect
  try {
    await (forwarder.connect(user) as any).depositAtomWithFeeExact(
      userAddr,
      ATOM_VAULT_ID,
      assetsAtom,
      { value: assetsAtom } // manquant: fee → doit revert
    )
    console.error("❌ ERREUR: l'appel avec msg.value incomplet n'a pas revert")
  } catch (e: any) {
    console.log("✅ Revert attendu (msg.value trop bas):", e?.shortMessage ?? e?.message ?? "reverted")
  }

  // 2) Appel correct
  const balFeeBefore = await ethers.provider.getBalance(feeRecipientAddr)
  const balMVBefore  = await ethers.provider.getBalance(MULTIVAULT)

  const tx1 = await (forwarder.connect(user) as any).depositAtomWithFeeExact(
    userAddr,
    ATOM_VAULT_ID,
    assetsAtom,
    { value: valueAtom }
  )
  const rc1 = await tx1.wait()
  console.log("depositAtom tx:", rc1?.hash)
  parseDeposited(rc1!.logs)

  const balFeeAfter = await ethers.provider.getBalance(feeRecipientAddr)
  const balMVAfter  = await ethers.provider.getBalance(MULTIVAULT)
  console.log("Δ feeRecipient:", (balFeeAfter - balFeeBefore).toString(), "wei")
  console.log("Δ multivault  :", (balMVAfter - balMVBefore).toString(), "wei")

  // ---- Dépôt TRIPLE (si fourni) ----
  if (TRIPLE_VAULT_ID) {
    const assetsTriple = minDeposit > 0n ? minDeposit : ethers.parseEther("0.005")
    const feeTriple: bigint = await forwarderRO.quoteFee(assetsTriple, userAddr)
    const valueTriple = assetsTriple + feeTriple
    console.log("assetsTriple:", assetsTriple.toString(), "feeTriple:", feeTriple.toString(), "total value:", valueTriple.toString())

    const balFeeBefore2 = await ethers.provider.getBalance(feeRecipientAddr)
    const balMVBefore2  = await ethers.provider.getBalance(MULTIVAULT)

    const tx2 = await (forwarder.connect(user) as any).depositTripleWithFeeExact(
      userAddr,
      TRIPLE_VAULT_ID,
      assetsTriple,
      { value: valueTriple }
    )
    const rc2 = await tx2.wait()
    console.log("depositTriple tx:", rc2?.hash)
    parseDeposited(rc2!.logs)

    const balFeeAfter2 = await ethers.provider.getBalance(feeRecipientAddr)
    const balMVAfter2  = await ethers.provider.getBalance(MULTIVAULT)
    console.log("Δ feeRecipient:", (balFeeAfter2 - balFeeBefore2).toString(), "wei")
    console.log("Δ multivault  :", (balMVAfter2 - balMVBefore2).toString(), "wei")
  } else {
    console.log("ℹ️ TRIPLE_VAULT_ID non défini — test triple sauté.")
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
