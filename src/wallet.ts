import { ethers } from 'ethers';

export interface WalletInfo {
  address: string;
  privateKey: string;
}

export function generateWallet(): WalletInfo {
  const wallet = ethers.Wallet.createRandom();
  return {
    address: wallet.address,
    privateKey: wallet.privateKey,
  };
}

export async function getWalletBalance(rpcUrl: string, privateKey: string): Promise<string> {
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);
  const balance = await provider.getBalance(wallet.address);
  return ethers.formatEther(balance);
}

export function getWalletAddress(privateKey: string): string {
  try {
    return new ethers.Wallet(privateKey).address;
  } catch {
    return '';
  }
}

export function getWalletAddressFull(privateKey: string): string {
  return getWalletAddress(privateKey);
}
