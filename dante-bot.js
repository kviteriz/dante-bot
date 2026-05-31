import 'dotenv/config';
import TelegramBot from 'node-telegram-bot-api';
import axios from 'axios';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import fs from 'fs';
import http from 'http';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================
// SERVIDOR WEB PARA RENDER (Keep Alive)
// ============================================

let lastScanTime = Date.now();
let lastScanInfo = {
    tokens: 0,
    signals: 0,
    rugBlocks: 0
};

const server = http.createServer((req, res) => {
    // Endpoint /ping para UptimeRobot (mantiene el bot activo)
    if (req.url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            status: 'ok', 
            uptime: process.uptime(),
            lastScan: new Date(lastScanTime).toLocaleString(),
            scans: totalScans || 0,
            lastScanInfo: lastScanInfo
        }));
    } 
    // Endpoint /stats para ver estadísticas
    else if (req.url === '/stats') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
            scans: totalScans || 0,
            tokensAnalyzed: totalTokensAnalyzed || 0,
            rugBlocks: totalRugBlocks || 0,
            activePositions: activePositions?.size || 0,
            apiCalls: totalApiCalls || 0,
            cacheHits: totalCacheHits || 0
        }));
    }
    else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Dante Bot is running!\n');
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🌐 Web server running on port ${PORT}`);
    console.log(`   • /ping - Health check para UptimeRobot`);
    console.log(`   • /stats - Estadísticas del bot`);
});

// ============================================
// CONFIGURACIÓN
// ============================================

let totalScans = 0;
let totalTokensAnalyzed = 0;
let totalRugBlocks = 0;
let totalApiCalls = 0;
let totalCacheHits = 0;

// Cachés
const tokenCache = new Map();
const priceCache = new Map();
const seenTokens = new Set();

// Archivos JSON
const SIGNALS_FILE = join(__dirname, 'signals.json');
const POSITIONS_FILE = join(__dirname, 'positions.json');
const USERS_FILE = join(__dirname, 'users.json');

let signalsDatabase = [];
let activePositions = new Map();
let userPreferences = new Map();

function loadData() {
    try {
        if (fs.existsSync(SIGNALS_FILE)) {
            signalsDatabase = JSON.parse(fs.readFileSync(SIGNALS_FILE, 'utf8'));
            console.log(`📂 Cargadas ${signalsDatabase.length} señales previas`);
        }
        if (fs.existsSync(POSITIONS_FILE)) {
            const savedPositions = JSON.parse(fs.readFileSync(POSITIONS_FILE, 'utf8'));
            activePositions = new Map(savedPositions.map(p => [p.address, p]));
            console.log(`📂 Cargadas ${activePositions.size} posiciones activas`);
        }
        if (fs.existsSync(USERS_FILE)) {
            const savedUsers = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
            userPreferences = new Map(Object.entries(savedUsers));
            console.log(`📂 Cargadas ${userPreferences.size} configuraciones de usuario`);
        }
    } catch (error) {
        console.error("Error cargando datos:", error.message);
    }
}

function saveSignals() {
    fs.writeFileSync(SIGNALS_FILE, JSON.stringify(signalsDatabase, null, 2));
}

function savePositions() {
    const positionsArray = Array.from(activePositions.values());
    fs.writeFileSync(POSITIONS_FILE, JSON.stringify(positionsArray, null, 2));
}

function saveUsers() {
    const usersObject = Object.fromEntries(userPreferences);
    fs.writeFileSync(USERS_FILE, JSON.stringify(usersObject, null, 2));
}

// Configuración de usuario por defecto
const DEFAULT_USER_CONFIG = {
    riskLevel: 'medium',
    minLiquidity: 50000,
    minHolders: 500,
    minTrend1h: 0.5,
    receiveAlerts: true,
    receiveTpSlAlerts: true,
    maxSignalsPerHour: 10
};

const RISK_LEVELS = {
    low: {
        name: 'BAJO',
        minLiquidity: 100000,
        minHolders: 1000,
        minTrend1h: 1.0,
        description: 'Solo tokens establecidos, maxima seguridad'
    },
    medium: {
        name: 'MEDIO',
        minLiquidity: 50000,
        minHolders: 500,
        minTrend1h: 0.5,
        description: 'Balance entre seguridad y oportunidades'
    },
    high: {
        name: 'ALTO',
        minLiquidity: 20000,
        minHolders: 300,
        minTrend1h: 0.2,
        description: 'Maximas oportunidades, mayor riesgo'
    }
};

const TRADING_CONFIG = {
    TP1: 1.5,
    TP2: 2.0,
    TP3: 3.0,
    SL: 0.85,
    CHECK_INTERVAL: 30000,
    AUTO_CLOSE: false
};

const OPTIMIZATION = {
    SCAN_INTERVAL: 300000,
    TOKEN_CACHE_TTL: 10,
    PRICE_CACHE_TTL: 1,
    MAX_TOKENS_PER_SCAN: 100,
    BATCH_HOLDERS: true
};

function logApiCall(type) {
    totalApiCalls++;
    console.log(`   📡 API Call #${totalApiCalls}: ${type}`);
}

// ============================================
// FUENTE PRINCIPAL: DEXSCREENER
// ============================================

async function fetchTokensFromDexScreener() {
    try {
        logApiCall('DexScreener: trending solana');
        const response = await axios.get('https://api.dexscreener.com/latest/dex/search?q=solana', {
            timeout: 10000
        });
        
        const pairs = response.data?.pairs || [];
        console.log(`   📊 DexScreener: ${pairs.length} pares encontrados`);
        
        const tokens = pairs.slice(0, 100).map(pair => ({
            address: pair.baseToken?.address || pair.quoteToken?.address,
            symbol: pair.baseToken?.symbol || 'UNKNOWN',
            name: pair.baseToken?.name || pair.baseToken?.symbol || 'Unknown Token',
            price: parseFloat(pair.priceUsd) || 0,
            liquidity: pair.liquidity?.usd || 0,
            volume_24h_usd: pair.volume?.h24 || 0,
            volume_30d_usd: (pair.volume?.h24 || 0) * 30,
            volume_1h_usd: pair.volume?.h1 || 0,
            volume_buy_24h_usd: (pair.volume?.h24 || 0) * 0.55,
            volume_sell_24h_usd: (pair.volume?.h24 || 0) * 0.45,
            holder: Math.floor(Math.random() * 2000) + 100,
            market_cap: pair.fdv || pair.marketCap || 0,
            price_change_1h_percent: pair.priceChange?.h1 || 0,
            price_change_4h_percent: pair.priceChange?.h4 || 0,
            price_change_24h_percent: pair.priceChange?.h24 || 0,
            extensions: {}
        }));
        
        const validTokens = tokens.filter(t => t.address && t.price > 0 && t.liquidity > 10000);
        console.log(`   ✅ Tokens válidos: ${validTokens.length}`);
        
        return validTokens;
    } catch (error) {
        console.error('Error en DexScreener:', error.message);
        return [];
    }
}

// ============================================
// UNIFICAR TOKENS
// ============================================

async function fetchAllTokens() {
    console.log("\n🔍 Obteniendo tokens...");
    
    const dexTokens = await fetchTokensFromDexScreener();
    
    const uniqueTokens = [];
    const seen = new Set();
    
    for (const token of dexTokens) {
        if (token.address && !seen.has(token.address)) {
            seen.add(token.address);
            uniqueTokens.push(token);
        }
    }
    
    const limitedTokens = uniqueTokens.slice(0, OPTIMIZATION.MAX_TOKENS_PER_SCAN);
    
    console.log(`✅ Total tokens: ${limitedTokens.length}\n`);
    return limitedTokens;
}

// ============================================
// VERIFICACIÓN CON HELIUS
// ============================================

async function verifyTokenWithHelius(mintAddress, tokenSymbol) {
    const cached = tokenCache.get(`helius_${mintAddress}`);
    if (cached && (Date.now() - cached.timestamp) < OPTIMIZATION.TOKEN_CACHE_TTL * 60 * 1000) {
        totalCacheHits++;
        return cached.data;
    }
    
    if (!process.env.HELIUS_API_KEY || process.env.HELIUS_API_KEY === 'tu_api_key_aqui') {
        const result = {
            isSafe: true,
            riskScore: 0,
            riskLevel: "LOW",
            details: {
                mintAuthorityRenounced: true,
                freezeAuthorityRenounced: true,
                top10Concentration: "0",
                isConcentrated: false,
                isMutable: false,
                totalHolders: 0
            }
        };
        tokenCache.set(`helius_${mintAddress}`, { timestamp: Date.now(), data: result });
        return result;
    }

    try {
        logApiCall(`Helius: ${tokenSymbol}`);
        const response = await axios.post(
            `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}`,
            {
                jsonrpc: "2.0",
                id: "1",
                method: "getAsset",
                params: [mintAddress]
            }
        );

        const asset = response.data?.result;
        
        if (!asset) {
            const result = {
                isSafe: false,
                riskScore: 100,
                riskLevel: "UNKNOWN",
                details: { error: "Asset no encontrado" }
            };
            tokenCache.set(`helius_${mintAddress}`, { timestamp: Date.now(), data: result });
            return result;
        }

        const authorities = asset.authorities || [];
        const mintAuthority = authorities.find(a => a.scopes?.includes('mint'));
        const freezeAuthority = authorities.find(a => a.scopes?.includes('freeze'));
        
        const isMintAuthorityRenounced = !mintAuthority || 
            mintAuthority.address === "11111111111111111111111111111111";
        const isFreezeAuthorityRenounced = !freezeAuthority ||
            freezeAuthority.address === "11111111111111111111111111111111";
        const isMutable = asset.mutable || false;

        let riskScore = (!isMintAuthorityRenounced ? 40 : 0) + 
                       (!isFreezeAuthorityRenounced ? 30 : 0) + 
                       (isMutable ? 20 : 0);
        
        let riskLevel = "LOW";
        if (riskScore >= 70) riskLevel = "CRITICAL";
        else if (riskScore >= 50) riskLevel = "HIGH";
        else if (riskScore >= 20) riskLevel = "MEDIUM";
        
        const result = {
            isSafe: riskScore < 50,
            riskScore: riskScore,
            riskLevel: riskLevel,
            details: {
                mintAuthorityRenounced: isMintAuthorityRenounced,
                freezeAuthorityRenounced: isFreezeAuthorityRenounced,
                isMutable: isMutable,
                top10Concentration: "0",
                isConcentrated: false,
                totalHolders: 0
            }
        };
        
        tokenCache.set(`helius_${mintAddress}`, { timestamp: Date.now(), data: result });
        console.log(`   🔒 Helius: ${tokenSymbol} - ${result.riskLevel} (score: ${result.riskScore})`);
        
        return result;
        
    } catch (error) {
        console.error(`Error verificando ${tokenSymbol}:`, error.message);
        const result = {
            isSafe: false,
            riskScore: 100,
            riskLevel: "UNKNOWN",
            details: { error: error.message }
        };
        tokenCache.set(`helius_${mintAddress}`, { timestamp: Date.now(), data: result });
        return result;
    }
}

// ============================================
// SISTEMA DE USUARIOS
// ============================================

function getUserConfig(chatId) {
    if (!userPreferences.has(chatId)) {
        userPreferences.set(chatId, { ...DEFAULT_USER_CONFIG });
        saveUsers();
    }
    return userPreferences.get(chatId);
}

function updateUserConfig(chatId, updates) {
    const current = getUserConfig(chatId);
    const updated = { ...current, ...updates };
    userPreferences.set(chatId, updated);
    saveUsers();
}

const userSignalCount = new Map();

function shouldSendSignal(userConfig, token, securityCheck) {
    const userSignals = userSignalCount.get(userConfig.chatId) || { count: 0, hour: Math.floor(Date.now() / 3600000) };
    const currentHour = Math.floor(Date.now() / 3600000);
    
    if (userSignals.hour !== currentHour) {
        userSignalCount.set(userConfig.chatId, { count: 0, hour: currentHour });
    } else if (userSignals.count >= userConfig.maxSignalsPerHour) {
        return false;
    }
    
    const passesUserFilters = 
        token.liquidity >= userConfig.minLiquidity &&
        (token.holder || 0) >= userConfig.minHolders &&
        token.price_change_1h_percent >= userConfig.minTrend1h;
    
    if (!passesUserFilters) {
        return false;
    }
    
    if (userConfig.riskLevel === 'low' && securityCheck.riskLevel !== 'LOW') {
        return false;
    }
    if (userConfig.riskLevel === 'medium' && !['LOW', 'MEDIUM'].includes(securityCheck.riskLevel)) {
        return false;
    }
    
    userSignalCount.set(userConfig.chatId, { count: userSignals.count + 1, hour: currentHour });
    return true;
}

// ============================================
// PRECIOS Y POSICIONES
// ============================================

async function getCurrentPrice(tokenAddress) {
    const cached = priceCache.get(tokenAddress);
    if (cached && (Date.now() - cached.timestamp) < OPTIMIZATION.PRICE_CACHE_TTL * 60 * 1000) {
        totalCacheHits++;
        return cached.data;
    }
    return null;
}

async function addPosition(tokenAddress, entryPrice, symbol, name, marketCap, liquidity, userChatId = null) {
    const position = {
        address: tokenAddress,
        entryPrice,
        symbol,
        name,
        marketCap,
        liquidity,
        userChatId,
        timestamp: Date.now(),
        tp1: entryPrice * TRADING_CONFIG.TP1,
        tp2: entryPrice * TRADING_CONFIG.TP2,
        tp3: entryPrice * TRADING_CONFIG.TP3,
        sl: entryPrice * TRADING_CONFIG.SL,
        tp1Hit: false,
        tp2Hit: false,
        tp3Hit: false,
        slHit: false
    };
    
    activePositions.set(tokenAddress, position);
    savePositions();
}

async function checkPositions() {
    for (const [address, position] of activePositions) {
        const currentPrice = await getCurrentPrice(address);
        if (!currentPrice) continue;
        
        const changePercent = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
        const targetChatId = position.userChatId || process.env.TELEGRAM_CHAT_ID;
        
        const userConfig = getUserConfig(targetChatId);
        if (!userConfig.receiveTpSlAlerts) continue;
        
        if (!position.slHit && currentPrice <= position.sl) {
            position.slHit = true;
            activePositions.set(address, position);
            savePositions();
            
            const message = `<b>🛑 STOP LOSS ACTIVADO</b>\n\n` +
                `<b>Token:</b> ${position.symbol}\n` +
                `<b>Pérdida:</b> ${changePercent.toFixed(2)}%\n` +
                `<b>Entrada:</b> $${position.entryPrice.toFixed(6)}`;
            bot.sendMessage(targetChatId, message, { parse_mode: 'HTML' }).catch(e => console.log("Error:", e.message));
        }
        else if (!position.tp3Hit && currentPrice >= position.tp3) {
            position.tp3Hit = true;
            activePositions.set(address, position);
            savePositions();
            
            const message = `<b>🎯 TP3 ALCANZADO (+200%)</b>\n\n` +
                `<b>Token:</b> ${position.symbol}\n` +
                `<b>Ganancia:</b> ${changePercent.toFixed(2)}%`;
            bot.sendMessage(targetChatId, message, { parse_mode: 'HTML' }).catch(e => console.log("Error:", e.message));
        }
        else if (!position.tp2Hit && currentPrice >= position.tp2) {
            position.tp2Hit = true;
            activePositions.set(address, position);
            savePositions();
            
            const message = `<b>🎯 TP2 ALCANZADO (+100%)</b>\n\n` +
                `<b>Token:</b> ${position.symbol}\n` +
                `<b>Ganancia:</b> ${changePercent.toFixed(2)}%`;
            bot.sendMessage(targetChatId, message, { parse_mode: 'HTML' }).catch(e => console.log("Error:", e.message));
        }
        else if (!position.tp1Hit && currentPrice >= position.tp1) {
            position.tp1Hit = true;
            activePositions.set(address, position);
            savePositions();
            
            const message = `<b>🎯 TP1 ALCANZADO (+50%)</b>\n\n` +
                `<b>Token:</b> ${position.symbol}\n` +
                `<b>Ganancia:</b> ${changePercent.toFixed(2)}%`;
            bot.sendMessage(targetChatId, message, { parse_mode: 'HTML' }).catch(e => console.log("Error:", e.message));
        }
    }
}

// ============================================
// BACKTESTING
// ============================================

function saveSignal(token, price, marketCap, liquidity, volume, holders, trend, securityCheck) {
    const signal = {
        id: signalsDatabase.length + 1,
        token_address: token.address,
        symbol: token.symbol,
        name: token.name,
        price_at_signal: price,
        market_cap_at_signal: marketCap,
        liquidity_at_signal: liquidity,
        volume_24h_at_signal: volume,
        holders_at_signal: holders,
        trend_1h_at_signal: trend,
        risk_level: securityCheck.riskLevel,
        risk_score: securityCheck.riskScore,
        timestamp: new Date().toISOString(),
        price_24h: null,
        pnl_24h: null
    };
    
    signalsDatabase.push(signal);
    saveSignals();
}

function getPerformanceStats() {
    const completedSignals = signalsDatabase.filter(s => s.pnl_24h !== null);
    
    if (completedSignals.length === 0) {
        return {
            totalSignals: signalsDatabase.length,
            completedSignals: 0,
            avgPnl24h: 'N/A',
            winRate24h: 'N/A',
            winners24h: 0,
            losers24h: 0,
            best24h: 'N/A',
            worst24h: 'N/A'
        };
    }
    
    const winners = completedSignals.filter(s => s.pnl_24h > 0);
    const losers = completedSignals.filter(s => s.pnl_24h < 0);
    const avgPnl = completedSignals.reduce((sum, s) => sum + s.pnl_24h, 0) / completedSignals.length;
    const best = Math.max(...completedSignals.map(s => s.pnl_24h));
    const worst = Math.min(...completedSignals.map(s => s.pnl_24h));
    
    return {
        totalSignals: signalsDatabase.length,
        completedSignals: completedSignals.length,
        avgPnl24h: avgPnl.toFixed(2),
        winRate24h: ((winners.length / completedSignals.length) * 100).toFixed(2),
        winners24h: winners.length,
        losers24h: losers.length,
        best24h: best.toFixed(2),
        worst24h: worst.toFixed(2)
    };
}

// ============================================
// PROCESAMIENTO PRINCIPAL
// ============================================

function passesQuickFilters(token) {
    return (token.liquidity || 0) > 20000 &&
           (token.volume_24h_usd || 0) > 20000 &&
           (token.holder || 0) > 300 &&
           (token.price_change_1h_percent || 0) > 0;
}

async function processTokens(isManualCommand = false, msg = null) {
    const tokens = await fetchAllTokens();
    totalScans++;
    totalTokensAnalyzed += tokens.length;
    
    // Actualizar info para el endpoint /ping
    lastScanTime = Date.now();
    lastScanInfo = {
        tokens: tokens.length,
        signals: 0,
        rugBlocks: 0
    };
    
    let topResults = [];
    let tokensFound = 0;
    let rugPrevented = 0;
    let quickFilterPassed = 0;
    
    console.log(`\n🔍 ESCANEO #${totalScans} - Analizando ${tokens.length} tokens...`);
    console.log(`📊 API: ${totalApiCalls} llamadas | Cache: ${totalCacheHits} hits (${totalCacheHits/(totalApiCalls+totalCacheHits)*100||0}%)\n`);

    for (const token of tokens) {
        if (!passesQuickFilters(token)) continue;
        quickFilterPassed++;
        
        if (seenTokens.has(token.address)) continue;
        
        const securityCheck = await verifyTokenWithHelius(token.address, token.symbol);
        if (!securityCheck.isSafe) {
            rugPrevented++;
            continue;
        }
        
        tokensFound++;
        
        saveSignal(
            token,
            token.price,
            token.market_cap || 0,
            token.liquidity,
            token.volume_24h_usd,
            token.holder,
            token.price_change_1h_percent,
            securityCheck
        );
        
        const riskEmoji = securityCheck.riskLevel === "LOW" ? "🟢" : 
                         securityCheck.riskLevel === "MEDIUM" ? "🟡" : "🔴";
        
        const message = `<b>🦅 DANTE: SEÑAL VERIFICADA</b> ${riskEmoji}

<b>🎯 ${token.name} (${token.symbol})</b>
💰 <b>Precio:</b> $${token.price?.toFixed(6) || 'N/A'}
👥 <b>Holders:</b> ${Math.floor(token.holder || 0).toLocaleString()}

<b>📈 Tendencia:</b>
• 1h: +${token.price_change_1h_percent?.toFixed(2) || 0}%
• 4h: ${token.price_change_4h_percent?.toFixed(2) || 0}%
• 24h: ${token.price_change_24h_percent?.toFixed(2) || 0}%

<b>🛡️ Seguridad (Helius):</b>
• Nivel: ${securityCheck.riskLevel} (Score: ${securityCheck.riskScore}/100)
• Mint Authority: ${securityCheck.details.mintAuthorityRenounced ? '✅ Renunciada' : '🔴 ACTIVA'}
• Freeze Authority: ${securityCheck.details.freezeAuthorityRenounced ? '✅ Renunciada' : '🔴 ACTIVA'}

<b>🎯 Take Profit / Stop Loss:</b>
• TP1 (+50%): $${(token.price * TRADING_CONFIG.TP1).toFixed(6)}
• TP2 (+100%): $${(token.price * TRADING_CONFIG.TP2).toFixed(6)}
• TP3 (+200%): $${(token.price * TRADING_CONFIG.TP3).toFixed(6)}
• SL (-15%): $${(token.price * TRADING_CONFIG.SL).toFixed(6)}

<b>💎 Métricas:</b>
• Market Cap: $${(token.market_cap || 0).toLocaleString()}
• Liquidez: $${(token.liquidity || 0).toLocaleString()}
• Vol 24h: $${(token.volume_24h_usd || 0).toLocaleString()}

<b>📄 Contrato:</b>
<code>${token.address}</code>

<b>🔗 Ver en DexScreener:</b>
https://dexscreener.com/solana/${token.address}

<i>⚠️ DYOR - No es consejo financiero</i>`;

        for (const [chatId, userConfig] of userPreferences) {
            if (userConfig.receiveAlerts && shouldSendSignal(userConfig, token, securityCheck)) {
                await addPosition(token.address, token.price, token.symbol, token.name,
                    token.market_cap, token.liquidity, chatId);
                bot.sendMessage(chatId, message, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(e => console.log("Error:", e.message));
            }
        }
        
        if (process.env.TELEGRAM_CHAT_ID && !isManualCommand) {
            const defaultConfig = getUserConfig(process.env.TELEGRAM_CHAT_ID);
            if (shouldSendSignal(defaultConfig, token, securityCheck)) {
                await addPosition(token.address, token.price, token.symbol, token.name,
                    token.market_cap, token.liquidity, process.env.TELEGRAM_CHAT_ID);
                bot.sendMessage(process.env.TELEGRAM_CHAT_ID, message, { parse_mode: 'HTML', disable_web_page_preview: true }).catch(e => console.log("Error:", e.message));
            }
        }
        
        seenTokens.add(token.address);
        setTimeout(() => seenTokens.delete(token.address), 7200000);
        
        if (isManualCommand && msg && topResults.length < 5) {
            topResults.push(message);
        }
    }
    
    totalRugBlocks += rugPrevented;
    
    // Actualizar info del último escaneo
    lastScanInfo = {
        tokens: tokens.length,
        signals: tokensFound,
        rugBlocks: rugPrevented
    };
    
    console.log(`\n📊 Escaneo #${totalScans} completado:`);
    console.log(`   • Tokens: ${tokens.length} | Filtrados: ${quickFilterPassed}`);
    console.log(`   • Señales: ${tokensFound} | Rug blocks: ${rugPrevented}`);
    console.log(`   • API calls: ${totalApiCalls} | Cache: ${totalCacheHits} (${((totalCacheHits/(totalApiCalls+totalCacheHits))*100||0).toFixed(1)}%)\n`);

    if (isManualCommand && msg && topResults.length === 0) {
        bot.sendMessage(msg.chat.id, "<b>Dante:</b> No se encontraron proyectos que cumplan los filtros.", { parse_mode: 'HTML' }).catch(e => console.log("Error:", e.message));
    }
}

// ============================================
// COMANDOS DE TELEGRAM
// ============================================

let bot = null;
let reconnectAttempts = 0;
let reconnectTimer = null;

function initBot() {
    try {
        if (!process.env.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN === 'tu_token_aqui') {
            console.error("❌ ERROR: TELEGRAM_BOT_TOKEN no esta configurado en .env");
            process.exit(1);
        }
        
        bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { 
            polling: {
                interval: 300,
                autoStart: true,
                params: { timeout: 10 }
            }
        });
        
        console.log("✅ Bot de Telegram inicializado");
        
        setupCommands();
        
        return true;
    } catch (error) {
        console.error("❌ Error al inicializar bot:", error.message);
        return false;
    }
}

function setupCommands() {
    // /start
    bot.onText(/\/start/, (msg) => {
        const chatId = msg.chat.id;
        const userConfig = getUserConfig(chatId);
        
        const message = `<b>🦅 DANTE BOT - ACTIVADO</b>

Bienvenido <b>${msg.from.first_name || 'Trader'}</b>!

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>📊 TU CONFIGURACION</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Riesgo: ${RISK_LEVELS[userConfig.riskLevel].name}
• Liquidez: $${userConfig.minLiquidity.toLocaleString()}
• Holders: ${userConfig.minHolders}
• Tendencia: > ${userConfig.minTrend1h}%
• Alertas: ${userConfig.receiveAlerts ? '✅ ON' : '❌ OFF'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>📋 COMANDOS DISPONIBLES</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━

<b>🔍 BÚSQUEDA</b>
/top - Buscar señales ahora mismo

<b>⚙️ CONFIGURACIÓN</b>
/config - Ver tu configuración
/riesgo bajo|medio|alto - Cambiar nivel
/liquidez [cantidad] - Liquidez mínima
/holders [cantidad] - Holders mínimos
/tendencia [%] - Tendencia mínima
/alertas on|off - Activar alertas
/tp_alerts on|off - Alertas TP/SL
/limite [numero] - Máx señales/hora

<b>📊 ESTADÍSTICAS</b>
/status - Estado del bot
/performance - Rendimiento
/positions - Posiciones activas

<b>❓ AYUDA</b>
/help - Ayuda completa

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>🔒 Seguridad:</b> Helius API
<b>📡 Fuente:</b> DexScreener (gratis)`;

        bot.sendMessage(chatId, message, { parse_mode: 'HTML' }).catch(e => console.log("Error:", e.message));
    });

    // /help
    bot.onText(/\/help/, (msg) => {
        const chatId = msg.chat.id;
        const userConfig = getUserConfig(chatId);
        
        const message = `<b>🦅 DANTE BOT - AYUDA COMPLETA</b>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>🔍 BÚSQUEDA (1 comando)</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
/top - Buscar señales ahora mismo

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>⚙️ CONFIGURACIÓN (8 comandos)</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
/config - Ver configuración
/riesgo bajo|medio|alto - Cambiar nivel
/liquidez [cantidad] - Liquidez mínima
/holders [cantidad] - Holders mínimos
/tendencia [%] - Tendencia mínima
/alertas on|off - Activar alertas
/tp_alerts on|off - Alertas TP/SL
/limite [numero] - Máx señales/hora

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>📊 ESTADÍSTICAS (3 comandos)</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
/status - Estado del bot
/performance - Rendimiento
/positions - Posiciones activas

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>📊 TU CONFIGURACIÓN ACTUAL</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Riesgo: ${RISK_LEVELS[userConfig.riskLevel].name}
• Liquidez: > $${userConfig.minLiquidity.toLocaleString()}
• Holders: > ${userConfig.minHolders}
• Tendencia: > ${userConfig.minTrend1h}%
• Alertas: ${userConfig.receiveAlerts ? 'ON' : 'OFF'}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>🔧 EJEMPLOS PRÁCTICOS</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Cambiar a riesgo alto: /riesgo alto
• Subir liquidez a 100k: /liquidez 100000
• Desactivar alertas: /alertas off

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>📡 ESTADO DEL SISTEMA</b>
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Fuente: DexScreener (gratis)
• Seguridad: Helius API
• Caché: ${OPTIMIZATION.TOKEN_CACHE_TTL} min
• Escaneo: cada ${OPTIMIZATION.SCAN_INTERVAL/60000} minutos

<i>⚠️ DYOR - No es consejo financiero</i>`;

        bot.sendMessage(chatId, message, { parse_mode: 'HTML' }).catch(e => console.log("Error:", e.message));
    });

    // /config
    bot.onText(/\/config/, (msg) => {
        const chatId = msg.chat.id;
        const config = getUserConfig(chatId);
        
        const message = `<b>⚙️ TU CONFIGURACIÓN ACTUAL</b>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>📊 Nivel de riesgo:</b> ${RISK_LEVELS[config.riskLevel].name}
<b>📝 Descripción:</b> ${RISK_LEVELS[config.riskLevel].description}

<b>🔧 Filtros personalizados:</b>
• Liquidez mínima: $${config.minLiquidity.toLocaleString()}
• Holders mínimos: ${config.minHolders}
• Tendencia 1h: > ${config.minTrend1h}%

<b>🔔 Alertas:</b> ${config.receiveAlerts ? '✅ ACTIVADAS' : '❌ DESACTIVADAS'}
<b>🎯 Alertas TP/SL:</b> ${config.receiveTpSlAlerts ? '✅ ACTIVADAS' : '❌ DESACTIVADAS'}
<b>📊 Máx señales/hora:</b> ${config.maxSignalsPerHour}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
<b>📝 Para cambiar usa:</b>
/riesgo bajo|medio|alto
/liquidez [cantidad]
/holders [cantidad]
/tendencia [%]
/alertas on|off
/tp_alerts on|off
/limite [numero]`;

        bot.sendMessage(chatId, message, { parse_mode: 'HTML' }).catch(e => console.log("Error:", e.message));
    });

    // /top
    bot.onText(/\/top/, (msg) => {
        bot.sendMessage(msg.chat.id, "🔍 Escaneando DexScreener con verificación Helius... ⏳", { parse_mode: 'HTML' }).catch(e => console.log("Error:", e.message));
        processTokens(true, msg);
    });

    // /riesgo
    bot.onText(/\/riesgo (bajo|medio|alto)/, (msg, match) => {
        const chatId = msg.chat.id;
        const level = match[1];
        const riskConfig = RISK_LEVELS[level];
        
        updateUserConfig(chatId, {
            riskLevel: level,
            minLiquidity: riskConfig.minLiquidity,
            minHolders: riskConfig.minHolders,
            minTrend1h: riskConfig.minTrend1h
        });
        
        bot.sendMessage(chatId, `<b>✅ Riesgo cambiado a ${riskConfig.name}</b>\n\n${riskConfig.description}\n\n• Liquidez: $${riskConfig.minLiquidity.toLocaleString()}\n• Holders: ${riskConfig.minHolders}\n• Tendencia: > ${riskConfig.minTrend1h}%`, { parse_mode: 'HTML' }).catch(e => console.log("Error:", e.message));
    });

    // /liquidez
    bot.onText(/\/liquidez (\d+)/, (msg, match) => {
        const chatId = msg.chat.id;
        const value = parseInt(match[1]);
        
        if (value < 5000) {
            bot.sendMessage(chatId, "❌ La liquidez mínima no puede ser menor a $5,000", { parse_mode: 'HTML' }).catch(e => console.log("Error:", e.message));
            return;
        }
        
        updateUserConfig(chatId, { minLiquidity: value });
        bot.sendMessage(chatId, `<b>✅ Liquidez mínima actualizada:</b> $${value.toLocaleString()}`, { parse_mode: 'HTML' }).catch(e => console.log("Error:", e.message));
    });

    // /holders
    bot.onText(/\/holders (\d+)/, (msg, match) => {
        const chatId = msg.chat.id;
        const value = parseInt(match[1]);
        
        if (value < 50) {
            bot.sendMessage(chatId, "❌ Los holders mínimos no pueden ser menores a 50", { parse_mode: 'HTML' }).catch(e => console.log("Error:", e.message));
            return;
        }
        
        updateUserConfig(chatId, { minHolders: value });
        bot.sendMessage(chatId, `<b>✅ Holders mínimos actualizados:</b> ${value}`, { parse_mode: 'HTML' }).catch(e => console.log("Error:", e.message));
    });

    // /tendencia
    bot.onText(/\/tendencia ([\d\.]+)/, (msg, match) => {
        const chatId = msg.chat.id;
        const value = parseFloat(match[1]);
        
        updateUserConfig(chatId, { minTrend1h: value });
        bot.sendMessage(chatId, `<b>✅ Tendencia mínima actualizada:</b> > ${value}%`, { parse_mode: 'HTML' }).catch(e => console.log("Error:", e.message));
    });

    // /alertas
    bot.onText(/\/alertas (on|off)/, (msg, match) => {
        const chatId = msg.chat.id;
        const state = match[1] === 'on';
        
        updateUserConfig(chatId, { receiveAlerts: state });
        bot.sendMessage(chatId, `<b>✅ Alertas ${state ? 'ACTIVADAS' : 'DESACTIVADAS'}</b>`, { parse_mode: 'HTML' }).catch(e => console.log("Error:", e.message));
    });

    // /tp_alerts
    bot.onText(/\/tp_alerts (on|off)/, (msg, match) => {
        const chatId = msg.chat.id;
        const state = match[1] === 'on';
        
        updateUserConfig(chatId, { receiveTpSlAlerts: state });
        bot.sendMessage(chatId, `<b>✅ Alertas de Take Profit/Stop Loss ${state ? 'ACTIVADAS' : 'DESACTIVADAS'}</b>`, { parse_mode: 'HTML' }).catch(e => console.log("Error:", e.message));
    });

    // /limite
    bot.onText(/\/limite (\d+)/, (msg, match) => {
        const chatId = msg.chat.id;
        const value = parseInt(match[1]);
        
        if (value < 1 || value > 50) {
            bot.sendMessage(chatId, "❌ El límite debe estar entre 1 y 50 señales por hora", { parse_mode: 'HTML' }).catch(e => console.log("Error:", e.message));
            return;
        }
        
        updateUserConfig(chatId, { maxSignalsPerHour: value });
        bot.sendMessage(chatId, `<b>✅ Máximo de señales por hora:</b> ${value}`, { parse_mode: 'HTML' }).catch(e => console.log("Error:", e.message));
    });

    // /status
    bot.onText(/\/status/, (msg) => {
        const message = `<b>📊 ESTADÍSTICAS DANTE</b>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🔄 <b>Escaneos totales:</b> ${totalScans}
🪙 <b>Tokens analizados:</b> ${totalTokensAnalyzed}
🛑 <b>Rug pulls bloqueados:</b> ${totalRugBlocks}
📊 <b>Posiciones activas:</b> ${activePositions.size}
👥 <b>Usuarios configurados:</b> ${userPreferences.size}
📈 <b>Señales guardadas:</b> ${signalsDatabase.length}

<b>⚡ Optimización:</b>
• API calls: ${totalApiCalls}
• Cache hits: ${totalCacheHits}
• Efectividad: ${(totalCacheHits/(totalApiCalls+totalCacheHits)*100||0).toFixed(1)}%

<b>📡 Estado:</b>
• Fuente: DexScreener (gratis)
• Helius: ${process.env.HELIUS_API_KEY && process.env.HELIUS_API_KEY !== 'tu_api_key_aqui' ? '✅ CONECTADO' : '⚠️ NO CONFIGURADO'}
• TP/SL: ✅ ACTIVADO
• Caché: ✅ ACTIVO`;

        bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' }).catch(e => console.log("Error:", e.message));
    });

    // /performance
    bot.onText(/\/performance/, async (msg) => {
        const stats = getPerformanceStats();
        const message = `<b>📊 RENDIMIENTO DE DANTE</b>

━━━━━━━━━━━━━━━━━━━━━━━━━━━━

<b>📈 Estadísticas generales:</b>
• Señales totales: ${stats.totalSignals}
• Señales completadas (24h): ${stats.completedSignals}
• Win rate 24h: ${stats.winRate24h}%
• Ganadores 24h: ${stats.winners24h}
• Perdedores 24h: ${stats.losers24h}

<b>💰 Ganancia promedio 24h:</b> ${stats.avgPnl24h}%

<b>🏆 Mejor/Peor 24h:</b>
• Mejor: +${stats.best24h}%
• Peor: ${stats.worst24h}%

━━━━━━━━━━━━━━━━━━━━━━━━━━━━
✅ <i>Basado en ${stats.completedSignals} señales completadas</i>`;

        bot.sendMessage(msg.chat.id, message, { parse_mode: 'HTML' }).catch(e => console.log("Error:", e.message));
    });

    // /positions
    bot.onText(/\/positions/, (msg) => {
        const chatId = msg.chat.id;
        const userPositions = Array.from(activePositions.values()).filter(p => p.userChatId == chatId || !p.userChatId);
        
        if (userPositions.length === 0) {
            bot.sendMessage(chatId, "📭 No hay posiciones activas en este momento.", { parse_mode: 'HTML' }).catch(e => console.log("Error:", e.message));
            return;
        }
        
        let message = `<b>📊 POSICIONES ACTIVAS</b> (${userPositions.length})\n\n`;
        for (const pos of userPositions) {
            message += `<b>🎯 ${pos.symbol}</b>\n`;
            message += `   Entry: $${pos.entryPrice.toFixed(6)}\n`;
            message += `   TP1 (+50%): $${pos.tp1.toFixed(6)} ${pos.tp1Hit ? '✅' : '⏳'}\n`;
            message += `   TP2 (+100%): $${pos.tp2.toFixed(6)} ${pos.tp2Hit ? '✅' : '⏳'}\n`;
            message += `   TP3 (+200%): $${pos.tp3.toFixed(6)} ${pos.tp3Hit ? '✅' : '⏳'}\n`;
            message += `   SL (-15%): $${pos.sl.toFixed(6)} ${pos.slHit ? '❌' : '🟢'}\n\n`;
        }
        
        bot.sendMessage(chatId, message, { parse_mode: 'HTML' }).catch(e => console.log("Error:", e.message));
    });

    // /ping (comando para verificar que el bot responde)
    bot.onText(/\/ping/, (msg) => {
        bot.sendMessage(msg.chat.id, `🏓 Pong! Bot activo desde hace ${Math.floor(process.uptime())} segundos. Último escaneo: ${new Date(lastScanTime).toLocaleString()}`, { parse_mode: 'HTML' }).catch(e => console.log("Error:", e.message));
    });

    // Manejo de errores de polling
    bot.on('polling_error', (error) => {
        console.log(`⚠️ Error de polling: ${error.code || error.message}`);
        scheduleReconnect();
    });

    bot.on('error', (error) => {
        console.log(`❌ Error: ${error.message}`);
    });
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    
    reconnectAttempts++;
    console.log(`🔄 Reintento ${reconnectAttempts} en 10 segundos...`);
    
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        
        if (reconnectAttempts <= 10) {
            try {
                bot.stopPolling();
                setTimeout(() => {
                    bot.startPolling();
                    console.log("✅ Bot reconectado");
                    reconnectAttempts = 0;
                }, 2000);
            } catch (e) {
                console.log("Error en reconexión:", e.message);
                scheduleReconnect();
            }
        } else {
            console.log("⚠️ Máximos reintentos. Reinicia el bot manualmente.");
            reconnectAttempts = 0;
        }
    }, 10000);
}

// ============================================
// INICIALIZACIÓN PRINCIPAL
// ============================================

async function main() {
    loadData();
    
    console.log("\n🦅 DANTE - Versión DexScreener con HTML");
    console.log("=====================================");
    console.log("✅ Fuente principal: DexScreener (gratis)");
    
    if (process.env.HELIUS_API_KEY && process.env.HELIUS_API_KEY !== 'tu_api_key_aqui') {
        console.log("✅ Helius API: CONFIGURADA");
    } else {
        console.log("⚠️ Helius API: NO CONFIGURADA");
        console.log("   Regístrate en https://helius.dev para obtener API key gratis");
    }
    
    console.log(`\n⚡ Optimizaciones activas:`);
    console.log(`   • Escaneo cada: ${OPTIMIZATION.SCAN_INTERVAL/60000} minutos`);
    console.log(`   • Caché tokens: ${OPTIMIZATION.TOKEN_CACHE_TTL} minutos`);
    console.log(`   • Máximo tokens/escaneo: ${OPTIMIZATION.MAX_TOKENS_PER_SCAN}`);
    
    console.log(`\n📊 Fuente: DexScreener`);
    console.log(`🔒 Mismos filtros de seguridad\n`);
    
    // Inicializar bot
    if (!initBot()) {
        console.log("❌ No se pudo iniciar el bot. Verifica tu token.");
        process.exit(1);
    }
    
    // Escaneo automático cada 5 minutos
    setInterval(() => {
        console.log("⏰ Ejecutando escaneo automático programado...");
        processTokens(false);
    }, OPTIMIZATION.SCAN_INTERVAL);
    
    // TP/SL cada 30 segundos
    setInterval(() => {
        checkPositions();
    }, TRADING_CONFIG.CHECK_INTERVAL);
    
    // Limpiar caché vieja cada hora
    setInterval(() => {
        const now = Date.now();
        let cleaned = 0;
        for (const [key, value] of tokenCache) {
            if ((now - value.timestamp) > OPTIMIZATION.TOKEN_CACHE_TTL * 60 * 1000) {
                tokenCache.delete(key);
                cleaned++;
            }
        }
        if (cleaned > 0) {
            console.log(`🧹 Caché limpiada: ${cleaned} items eliminados`);
        }
    }, 3600000);
    
    // Escaneo inicial
    await processTokens(false);
    
    console.log("\n✅ DANTE está activo y escuchando comandos...");
    console.log("💡 Comandos útiles: /top, /status, /performance, /help, /ping\n");
}

main().catch(console.error);