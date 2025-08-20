// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal interface of the Multivault (Intuition) contract for deposits.
interface IEthMultiVault {
    function depositAtom(address receiver, uint256 vaultId) external payable;
    function depositTriple(address receiver, uint256 vaultId) external payable;
}

interface IERC721Like {
    function balanceOf(address owner) external view returns (uint256);
}

/// @title MultivaultForwarder - Simple router with fees
/// @notice Collects a fee on incoming ETH then forwards the rest to Multivault.
contract MultivaultForwarder {
    // --- Custom errors ---
    error InvalidAssets();       // inconsistent msg.value or zero assets
    error ExternalCallFailed();  // fee transfer failed
    error NotOwner();            // restricted access
    error FeeBpsTooHigh();       // > 2%

    // --- State (immutables + admin) ---
    IEthMultiVault public immutable multivault;     // Intuition target
    address payable public immutable feeRecipient;  // official address (Safe)

    address public owner;                           // admin (can adjust the rate)
    uint96  public feeBps;                          // ex: 100 = 1%
    uint256 public minFeeWei;                       // absolute minimum in wei (can be 0)
    IERC721Like public exemptionNft;                // optional; 0 => disabled

    // --- Events ---
    event FeesCollected(address indexed payer, bytes4 indexed op, uint256 amount);
    event FeeRatesChanged(uint96 bps, uint256 minFeeWei);
    event OwnerChanged(address indexed oldOwner, address indexed newOwner);
    event ExemptionNftChanged(address indexed nft);

    // --- Reentrancy guard (minimal) ---
    uint256 private _lock = 1;
    modifier nonReentrant() {
        require(_lock == 1, "REENTRANCY");
        _lock = 2;
        _;
        _lock = 1;
    }

    // --- Modifiers ---
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // --- Construction ---
    /// @param _multivault Address of the EthMultiVault contract
    /// @param _feeRecipient Official address that receives fees (immutable)
    /// @param _feeBps Rate in basis points (max 200 = 2%)
    /// @param _minFeeWei Minimum fee in wei (can be 0)
    constructor(
        address _multivault,
        address payable _feeRecipient,
        uint96 _feeBps,
        uint256 _minFeeWei
    ) {
        require(_multivault != address(0) && _feeRecipient != address(0), "zero addr");
        if (_feeBps > 200) revert FeeBpsTooHigh(); // 2% safeguard

        multivault = IEthMultiVault(_multivault);
        feeRecipient = _feeRecipient;

        feeBps = _feeBps;
        minFeeWei = _minFeeWei;
        owner = msg.sender;
    }

    // --- Light admin (no recipient change; immutable) ---
    function setOwner(address n) external onlyOwner {
        emit OwnerChanged(owner, n);
        owner = n;
    }

    function setFeeRates(uint96 _bps, uint256 _minFeeWei) external onlyOwner {
        if (_bps > 200) revert FeeBpsTooHigh(); // keep 2% max, consistent with constructor
        feeBps = _bps;
        minFeeWei = _minFeeWei;
        emit FeeRatesChanged(_bps, _minFeeWei);
    }

    function setExemptionNft(address nft) external onlyOwner {
        exemptionNft = IERC721Like(nft);
        emit ExemptionNftChanged(nft);
    }

    // --- Utilities ---
    receive() external payable {}

    function _isExempt(address payer) internal view returns (bool) {
        IERC721Like nft = exemptionNft;
        if (address(nft) == address(0)) return false;
        // try/catch non requis, interface simple
        return nft.balanceOf(payer) > 0;
    }

    function _feeOn(uint256 amount, address payer) internal view returns (uint256) {
        if (_isExempt(payer)) return 0;
        uint256 pct = (amount * feeBps) / 10_000;
        return pct < minFeeWei ? minFeeWei : pct;
    }

    /// @notice Public quotes for front-end UX
    function quoteFee(uint256 assets, address payer) public view returns (uint256) {
        return _feeOn(assets, payer);
    }

    function quoteTotal(uint256 assets, address payer) external view returns (uint256) {
        return assets + _feeOn(assets, payer);
    }

    // --- Deposits with fees (simple & explicit) ---
    /**
     * @notice The caller sends EXACTLY assets + fee(assets, msg.sender) in msg.value.
     * @param receiver Address that receives shares on Multivault side
     * @param vaultId  Id of the atom's vault
     * @param assets   Amount to deposit on Multivault side (wei)
     */
    function depositAtomWithFeeExact(
        address receiver,
        uint256 vaultId,
        uint256 assets
    ) external payable nonReentrant {
        if (assets == 0) revert InvalidAssets();

        uint256 fee = _feeOn(assets, msg.sender);
        if (msg.value != assets + fee) revert InvalidAssets();

        // 1) Forward net deposit to Multivault (bubbles revert reason)
        multivault.depositAtom{value: assets}(receiver, vaultId);

        // 2) Transfer fee to the official address
        (bool ok2, ) = feeRecipient.call{value: fee}("");
        if (!ok2) revert ExternalCallFailed();

        emit FeesCollected(msg.sender, IEthMultiVault.depositAtom.selector, fee);
    }

    /**
     * @notice Same for a triple.
     */
    function depositTripleWithFeeExact(
        address receiver,
        uint256 vaultId,
        uint256 assets
    ) external payable nonReentrant {
        if (assets == 0) revert InvalidAssets();

        uint256 fee = _feeOn(assets, msg.sender);
        if (msg.value != assets + fee) revert InvalidAssets();

        multivault.depositTriple{value: assets}(receiver, vaultId);

        (bool ok2, ) = feeRecipient.call{value: fee}("");
        if (!ok2) revert ExternalCallFailed();

        emit FeesCollected(msg.sender, IEthMultiVault.depositTriple.selector, fee);
    }

    /// @notice Rescue stray ETH sent by mistake
    function sweep(address payable to, uint256 amount) external onlyOwner {
        (bool ok, ) = to.call{value: amount}("");
        require(ok, "sweep failed");
    }
}
