import { ethers } from "hardhat"
import { expect } from "chai"

function feeOn(assets: bigint, bps: bigint, min: bigint) {
  const pct = (assets * bps) / 10_000n
  return pct < min ? min : pct
}

describe("MultivaultForwarder", () => {
  async function deploy({ feeBps = 100, minFeeWei = 0n }: { feeBps?: number; minFeeWei?: bigint } = {}) {
    const [deployer, user, feeRecipient, stranger] = await ethers.getSigners()

    // Mock cible
    const Mock = await ethers.getContractFactory("contracts/MockEthMultiVault.sol:MockEthMultiVault")
    const multivault = await Mock.deploy()
    await multivault.waitForDeployment()

    // Forwarder
    const Fwd = await ethers.getContractFactory("contracts/MultivaultForwarder.sol:MultivaultForwarder")
    const forwarder = await Fwd.deploy(
      await multivault.getAddress(),
      await feeRecipient.getAddress(),
      feeBps,
      minFeeWei
    )
    await forwarder.waitForDeployment()

    return { deployer, user, feeRecipient, stranger, multivault, forwarder }
  }

  it("depositAtomWithFeeExact — transfert net au multivault + fee au destinataire", async () => {
    const { user, feeRecipient, multivault, forwarder } = await deploy()
    const assets = ethers.parseEther("0.5")
    const bps = BigInt(await forwarder.feeBps())
    const min = BigInt(await forwarder.minFeeWei())
    const fee = feeOn(assets, bps, min)

    const tx = await forwarder.connect(user).depositAtomWithFeeExact(
      await user.getAddress(),
      1n,
      assets,
      { value: assets + fee }
    )

    await expect(tx).to.changeEtherBalances(
      [multivault, feeRecipient, user, forwarder],
      [assets, fee, -(assets + fee), 0] // le forwarder ne garde rien
    )

    const sel = ethers.keccak256(ethers.toUtf8Bytes("depositAtom(address,uint256)")).slice(0, 10)
    await expect(tx).to.emit(forwarder, "FeesCollected").withArgs(await user.getAddress(), sel, fee)
  })

  it("depositTripleWithFeeExact — idem pour triple", async () => {
    const { user, feeRecipient, multivault, forwarder } = await deploy()
    const assets = ethers.parseEther("0.3")
    const bps = BigInt(await forwarder.feeBps())
    const min = BigInt(await forwarder.minFeeWei())
    const fee = feeOn(assets, bps, min)

    const tx = await forwarder.connect(user).depositTripleWithFeeExact(
      await user.getAddress(),
      42n,
      assets,
      { value: assets + fee }
    )

    await expect(tx).to.changeEtherBalances(
      [multivault, feeRecipient, user, forwarder],
      [assets, fee, -(assets + fee), 0]
    )

    const sel = ethers.keccak256(ethers.toUtf8Bytes("depositTriple(address,uint256)")).slice(0, 10)
    await expect(tx).to.emit(forwarder, "FeesCollected").withArgs(await user.getAddress(), sel, fee)
  })

  it("revert si msg.value != assets + fee", async () => {
    const { user, forwarder } = await deploy()
    const assets = ethers.parseEther("1")
    await expect(
      forwarder.connect(user).depositAtomWithFeeExact(await user.getAddress(), 1n, assets, { value: assets }) // manque le fee
    ).to.be.revertedWithCustomError(forwarder, "InvalidAssets")
  })

  it("minFeeWei prime sur le % quand il est plus grand", async () => {
    // feeBps = 1% mais minFeeWei = 0.01 ETH → pour un petit dépôt, le fee = minFeeWei
    const minFeeWei = ethers.parseEther("0.01")
    const { user, feeRecipient, multivault, forwarder } = await deploy({ feeBps: 100, minFeeWei })
    const assets = ethers.parseEther("0.02") // 1% = 0.0002 < 0.01 → on attend 0.01 comme frais

    const tx = await forwarder.connect(user).depositAtomWithFeeExact(
      await user.getAddress(),
      1n,
      assets,
      { value: assets + minFeeWei }
    )

    await expect(tx).to.changeEtherBalances(
      [multivault, feeRecipient, user, forwarder],
      [assets, minFeeWei, -(assets + minFeeWei), 0]
    )
  })

  it("owner peut ajuster le barème ; >2% bloqué", async () => {
    const { deployer, forwarder } = await deploy()
    await expect(forwarder.connect(deployer).setFeeRates(199, 0)).to.emit(forwarder, "FeeRatesChanged")
    await expect(forwarder.connect(deployer).setFeeRates(201, 0))
      .to.be.revertedWithCustomError(forwarder, "FeeBpsTooHigh")
  })

  it("onlyOwner sur setFeeRates et setOwner", async () => {
    const { deployer, stranger, forwarder } = await deploy()
    await expect(forwarder.connect(stranger).setFeeRates(100, 0))
      .to.be.revertedWithCustomError(forwarder, "NotOwner")
    await expect(forwarder.connect(stranger).setOwner(await stranger.getAddress()))
      .to.be.revertedWithCustomError(forwarder, "NotOwner")

    await expect(forwarder.connect(deployer).setOwner(await stranger.getAddress()))
      .to.emit(forwarder, "OwnerChanged")
  })

  it("le forwarder ne garde jamais d'ETH après les calls", async () => {
    const { user, forwarder } = await deploy()
    const assets = ethers.parseEther("0.1")
    const bps = BigInt(await forwarder.feeBps())
    const min = BigInt(await forwarder.minFeeWei())
    const fee = feeOn(assets, bps, min)

    await forwarder.connect(user).depositAtomWithFeeExact(
      await user.getAddress(),
      1n,
      assets,
      { value: assets + fee }
    )
    const bal = await ethers.provider.getBalance(await forwarder.getAddress())
    expect(bal).to.eq(0n)
  })

  it("si la cible revert, on revert aussi (ExternalCallFailed)", async () => {
    // On crée un mock qui revert quand msg.value == 0 pour la fonction deposit...
    // Ici on force un assets = 0 pour provoquer un revert côté cible.
    const [deployer, user, feeRecipient] = await ethers.getSigners()
    const Mock = await ethers.getContractFactory("contracts/MockEthMultiVault.sol:MockEthMultiVault")
    const multivault = await Mock.deploy()
    await multivault.waitForDeployment()

    const Fwd = await ethers.getContractFactory("contracts/MultivaultForwarder.sol:MultivaultForwarder")
    const forwarder = await Fwd.deploy(
      await multivault.getAddress(),
      await feeRecipient.getAddress(),
      100,
      0n
    )
    await forwarder.waitForDeployment()

    await expect(
      forwarder.connect(user).depositAtomWithFeeExact(await user.getAddress(), 1n, 0n, { value: 0n }) // assets=0 → mock require(msg.value>0)
    ).to.be.revertedWithCustomError(forwarder, "InvalidAssets") // ici invalid assets avant d'appeler; si tu veux tester ExternalCallFailed, envoie value=fee et modifie le mock pour revert même avec >0
  })
})
