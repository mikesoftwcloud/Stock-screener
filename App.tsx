import React, { useState, useEffect, useRef } from 'react';
import { AlertCircle, TrendingUp, RefreshCw } from 'lucide-react';

interface Stock {
  symbol: string;
  intradayVolume: number;
  histVolume: number;
  relativeVolume: number;
  newsCount: number;
}

interface MarketStatus {
  isMarketHours: boolean;
  inFirstHour: boolean;
  isWeekday: boolean;
}

export default function VolumeScreener() {
  const [apiKey, setApiKey] = useState<string>('');
  const [isConfigured, setIsConfigured] = useState<boolean>(false);
  const [stocks, setStocks] = useState<Stock[]>([]);
  const [catalysts, setCatalysts] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<boolean>(false);
  const [marketStatus, setMarketStatus] = useState<string>('closed');
  const [watchlist, setWatchlist] = useState<string[]>(() => {
    const saved = localStorage.getItem('volumeScreenerWatchlist');
    return saved ? JSON.parse(saved) : ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'AMD', 'GOOGL', 'META', 'AMZN', 'SPY', 'QQQ'];
  });
  const [newTicker, setNewTicker] = useState<string>('');
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [timezone, setTimezone] = useState<string>(() => localStorage.getItem('volumeScreenerTimezone') || 'America/New_York');
  const [testMode, setTestMode] = useState<boolean>(false);
  const [currentTime, setCurrentTime] = useState<Date>(new Date());
  const [error, setError] = useState<string>('');
  const [debug, setDebug] = useState<boolean>(false);

  // Save watchlist to localStorage
  useEffect(() => {
    localStorage.setItem('volumeScreenerWatchlist', JSON.stringify(watchlist));
  }, [watchlist]);

  // Save timezone to localStorage
  useEffect(() => {
    localStorage.setItem('volumeScreenerTimezone', timezone);
  }, [timezone]);

  // Update current time every second for display
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  const checkMarketHours = (): MarketStatus => {
    if (testMode) {
      return { isMarketHours: true, inFirstHour: true, isWeekday: true };
    }

    // Convert current time to EST for market hours check
    const estTime = new Date(currentTime.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hours = estTime.getHours();
    const minutes = estTime.getMinutes();
    const dayOfWeek = estTime.getDay();
    
    // Market open: 9:30 AM - 4:00 PM EST, Mon-Fri
    const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5;
    const isMarketHours = isWeekday && (hours > 9 || (hours === 9 && minutes >= 30)) && hours < 16;
    const inFirstHour = isWeekday && ((hours === 9 && minutes >= 30) || (hours === 10 && minutes < 30));
    
    return { isMarketHours, inFirstHour, isWeekday };
  };

  // Get current time in selected timezone for display
  const getDisplayTime = (): string => {
    return currentTime.toLocaleString('en-US', { 
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true
    });
  };

  const fetchHistoricalVolume = async (symbol: string): Promise<number | null> => {
    if (!apiKey) return null;
    try {
      const response = await fetch(
        `https://finnhub.io/api/v1/stock/candle?symbol=${symbol}&resolution=D&count=30&token=${apiKey}`
      );
      const data = await response.json();
      
      if (!data.v || data.v.length === 0) return null;
      
      const avgVolume = data.v.reduce((a: number, b: number) => a + b, 0) / data.v.length;
      return avgVolume;
    } catch (error) {
      console.error(`Error fetching historical volume for ${symbol}:`, error);
      return null;
    }
  };

  const fetchIntradayVolume = async (symbol: string): Promise<number | null> => {
    if (!apiKey) return null;
    try {
      const response = await fetch(
        `https://finnhub.io/api/v1/stock/candle?symbol=${symbol}&resolution=1&from=${Math.floor(Date.now() / 1000) - 3600}&to=${Math.floor(Date.now() / 1000)}&token=${apiKey}`
      );
      const data = await response.json();
      
      if (!data.v || data.v.length === 0) return null;
      
      // Sum first 30 minutes (30 candles of 1-min bars)
      const first30MinVolume = data.v.slice(0, 30).reduce((a: number, b: number) => a + b, 0);
      return first30MinVolume;
    } catch (error) {
      console.error(`Error fetching intraday volume for ${symbol}:`, error);
      return null;
    }
  };

  const fetchNews = async (symbol: string): Promise<any[]> => {
    if (!apiKey) return [];
    try {
      const response = await fetch(
        `https://finnhub.io/api/v1/company-news?symbol=${symbol}&min_id=0&limit=10&token=${apiKey}`
      );
      const data = await response.json();
      return data || [];
    } catch (error) {
      console.error(`Error fetching news for ${symbol}:`, error);
      return [];
    }
  };

  const analyzeWithClaude = async (ticker: string, volumeData: any, newsData: any[]): Promise<string> => {
    try {
      const newsText = newsData.slice(0, 3).map((n: any) => `${n.headline}: ${n.summary}`).join('\n');
      
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 200,
          messages: [
            {
              role: 'user',
              content: `${ticker} has ${volumeData.relativeVolume}% of normal 30-day volume in first 30 minutes. Recent news: ${newsText || 'None'}. What catalyst likely drove this volume spike? List 1-2 key catalysts in 1-2 sentences.`
            }
          ],
        }),
      });

      const result = await response.json();
      return result.content[0].text;
    } catch (error) {
      console.error('Claude analysis error:', error);
      return 'Unable to analyze catalysts';
    }
  };

  const scanStocks = async () => {
    setError('');
    console.log('🔍 Scan started');
    console.log('API Key present:', !!apiKey);
    console.log('Watchlist:', watchlist);
    
    const { isMarketHours, inFirstHour } = checkMarketHours();
    console.log('Market hours check:', { isMarketHours, inFirstHour, testMode });
    
    if (!isMarketHours && !testMode) {
      const msg = 'Market is closed and test mode is OFF. Turn on Test Mode to scan anytime.';
      setError(msg);
      setMarketStatus('closed');
      console.log('❌', msg);
      return;
    }

    if (!apiKey) {
      const msg = 'API key not set. Please enter your Finnhub API key.';
      setError(msg);
      console.log('❌', msg);
      return;
    }

    setLoading(true);
    setMarketStatus(inFirstHour ? 'first-hour' : 'open');

    try {
      const results: Stock[] = [];

      for (const symbol of watchlist) {
        console.log(`📊 Scanning ${symbol}...`);
        try {
          const [histVolume, intradayVolume] = await Promise.all([
            fetchHistoricalVolume(symbol),
            fetchIntradayVolume(symbol),
          ]);

          console.log(`${symbol}: histVolume=${histVolume}, intradayVolume=${intradayVolume}`);

          if (histVolume && intradayVolume) {
            const relativeVolume = Math.round((intradayVolume / histVolume) * 100);
            console.log(`${symbol}: relativeVolume=${relativeVolume}%`);

            if (relativeVolume > 200) {
              console.log(`✅ ${symbol} flagged at ${relativeVolume}%`);
              const newsData = await fetchNews(symbol);
              results.push({
                symbol,
                intradayVolume,
                histVolume: Math.round(histVolume),
                relativeVolume,
                newsCount: newsData.length,
              });

              // Get catalyst analysis
              const catalyst = await analyzeWithClaude(symbol, { relativeVolume }, newsData);
              setCatalysts(prev => ({ ...prev, [symbol]: catalyst }));
            }
          }
        } catch (error) {
          console.error(`Error scanning ${symbol}:`, error);
        }
      }

      results.sort((a, b) => b.relativeVolume - a.relativeVolume);
      setStocks(results);
      setLastUpdate(new Date());
      console.log(`✅ Scan complete. Found ${results.length} stocks with high volume`);
      
      if (results.length === 0) {
        setError('No stocks found with >200% relative volume');
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error('❌ Scan error:', error);
      setError(`Scan failed: ${errorMsg}`);
    } finally {
      setLoading(false);
    }
  };

  const handleSetupComplete = () => {
    if (apiKey.trim()) {
      setIsConfigured(true);
      scanStocks();
      // Poll every 5 minutes during market hours
      pollIntervalRef.current = setInterval(() => {
        const { isMarketHours } = checkMarketHours();
        if (isMarketHours) {
          scanStocks();
        }
      }, 300000);
    }
  };

  const handleAddTicker = () => {
    if (newTicker && !watchlist.includes(newTicker.toUpperCase())) {
      setWatchlist([...watchlist, newTicker.toUpperCase()]);
      setNewTicker('');
    }
  };

  const handleRemoveTicker = (ticker: string) => {
    setWatchlist(watchlist.filter(t => t !== ticker));
  };

  useEffect(() => {
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, []);

  if (!isConfigured) {
    return (
      <div className="min-h-screen bg-slate-950 text-white p-8">
        <div className="max-w-md mx-auto pt-20">
          <div className="bg-slate-900 border border-slate-700 rounded-lg p-8">
            <h1 className="text-2xl font-bold mb-6 flex items-center gap-2">
              <TrendingUp className="w-8 h-8 text-emerald-500" />
              Volume Screener
            </h1>
            
            <p className="text-slate-400 mb-6 text-sm">
              Get a free API key from <a href="https://finnhub.io" target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">finnhub.io</a>
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">Finnhub API Key</label>
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && handleSetupComplete()}
                  placeholder="Paste your API key"
                  className="w-full px-4 py-2 bg-slate-800 border border-slate-600 rounded text-white text-sm focus:outline-none focus:border-emerald-500"
                />
              </div>

              <button
                onClick={handleSetupComplete}
                disabled={!apiKey.trim()}
                className="w-full bg-emerald-600 hover:bg-emerald-700 disabled:bg-slate-700 text-white font-medium py-2 rounded transition"
              >
                Start Screening
              </button>

              <p className="text-xs text-slate-500 text-center pt-4">
                This screener runs during market hours (9:30 AM - 4:00 PM EST, Mon-Fri)
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-white p-6">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-3xl font-bold flex items-center gap-3">
              <TrendingUp className="w-9 h-9 text-emerald-500" />
              Volume Screener
            </h1>
            <p className="text-slate-400 text-sm mt-1">
              Market Status: <span className={marketStatus === 'first-hour' ? 'text-red-400 font-bold' : 'text-emerald-400'}>{marketStatus === 'closed' ? 'Closed' : marketStatus === 'first-hour' ? 'FIRST HOUR ACTIVE' : 'Open'}</span>
              {testMode && <span className="ml-2 bg-yellow-600 px-2 py-0.5 rounded text-xs font-bold">TEST MODE</span>}
            </p>
            <p className="text-slate-400 text-xs mt-1">EST Time: {new Date(currentTime.toLocaleString('en-US', { timeZone: 'America/New_York' })).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })}</p>
          </div>
          <div className="flex flex-col gap-2">
            <select
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="bg-slate-800 border border-slate-600 rounded px-3 py-1 text-sm text-white"
            >
              <option value="America/New_York">EST (New York)</option>
              <option value="America/Chicago">CST (Chicago)</option>
              <option value="America/Denver">MST (Denver)</option>
              <option value="America/Los_Angeles">PST (Los Angeles)</option>
              <option value="America/Anchorage">AKST (Alaska)</option>
              <option value="Pacific/Honolulu">HST (Hawaii)</option>
              <option value="UTC">UTC</option>
            </select>
            <button
              onClick={() => setTestMode(!testMode)}
              className={`px-3 py-1 rounded text-sm font-medium transition ${
                testMode ? 'bg-yellow-600 hover:bg-yellow-700 text-white' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
              }`}
            >
              {testMode ? 'Test Mode: ON' : 'Test Mode: OFF'}
            </button>
            <button
              onClick={() => setDebug(!debug)}
              className={`px-3 py-1 rounded text-sm font-medium transition ${
                debug ? 'bg-blue-600 hover:bg-blue-700 text-white' : 'bg-slate-800 hover:bg-slate-700 text-slate-300'
              }`}
            >
              {debug ? 'Debug: ON' : 'Debug: OFF'}
            </button>
            <button
              onClick={scanStocks}
              disabled={loading}
              className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white px-3 py-1 rounded transition text-sm"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              {loading ? 'Scanning...' : 'Scan'}
            </button>
          </div>
        </div>

        {lastUpdate && (
          <p className="text-xs text-slate-500 mb-4">
            Last update: {lastUpdate.toLocaleTimeString()}
          </p>
        )}

        {error && (
          <div className="bg-red-900 border border-red-700 rounded-lg p-4 mb-4">
            <p className="text-red-200 text-sm">
              <span className="font-bold">⚠️ Error: </span>
              {error}
            </p>
            <p className="text-red-300 text-xs mt-2">
              Check browser console (F12 → Console tab) for detailed logs
            </p>
          </div>
        )}

        {/* Watchlist Manager */}
        <div className="bg-slate-900 border border-slate-700 rounded-lg p-4 mb-6">
          <h2 className="text-sm font-semibold text-slate-300 mb-3">Watchlist ({watchlist.length} stocks)</h2>
          <div className="flex flex-wrap gap-2 mb-3">
            {watchlist.map(ticker => (
              <div
                key={ticker}
                className="bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs flex items-center gap-2"
              >
                {ticker}
                <button
                  onClick={() => handleRemoveTicker(ticker)}
                  className="text-slate-500 hover:text-red-400 transition"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              type="text"
              value={newTicker}
              onChange={(e) => setNewTicker(e.target.value.toUpperCase())}
              onKeyPress={(e) => e.key === 'Enter' && handleAddTicker()}
              placeholder="Add ticker (e.g., AAPL)"
              className="flex-1 px-3 py-1 bg-slate-800 border border-slate-600 rounded text-sm text-white focus:outline-none focus:border-emerald-500"
            />
            <button
              onClick={handleAddTicker}
              className="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1 rounded text-sm transition"
            >
              Add
            </button>
          </div>
        </div>

        {/* Debug Panel */}
        {debug && (
          <div className="bg-slate-900 border border-blue-700 rounded-lg p-4 mb-6">
            <h2 className="text-sm font-semibold text-blue-300 mb-3">🐛 Debug Info</h2>
            <div className="space-y-2 text-xs text-slate-300 font-mono">
              <p>API Key: <span className={apiKey ? 'text-green-400' : 'text-red-400'}>{apiKey ? '✓ Set' : '✗ Not set'}</span></p>
              <p>Market Status: <span className="text-yellow-400">{marketStatus}</span></p>
              <p>Test Mode: <span className={testMode ? 'text-yellow-400' : 'text-slate-400'}>{testMode ? '✓ ON' : '✗ OFF'}</span></p>
              <p>Timezone: <span className="text-cyan-400">{timezone}</span></p>
              <p>EST Time: <span className="text-cyan-400">{new Date(currentTime.toLocaleString('en-US', { timeZone: 'America/New_York' })).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })}</span></p>
              <p>Loading: <span className={loading ? 'text-yellow-400' : 'text-slate-400'}>{loading ? '⟳ Scanning' : '—'}</span></p>
              <p className="pt-2">Open browser console (F12 → Console) to see detailed scan logs</p>
            </div>
          </div>
        )}

        {/* Results */}
        <div className="space-y-4">
          {stocks.length > 0 ? (
            stocks.map(stock => (
              <div key={stock.symbol} className="bg-slate-900 border border-slate-700 rounded-lg p-4 hover:border-emerald-500 transition">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="text-xl font-bold">{stock.symbol}</h3>
                    <p className="text-slate-400 text-sm">
                      30-day avg: {stock.histVolume.toLocaleString()} | Current: {stock.intradayVolume.toLocaleString()}
                    </p>
                  </div>
                  <div className="text-right">
                    <div className="text-3xl font-bold text-red-500">{stock.relativeVolume}%</div>
                    <p className="text-xs text-slate-400">of normal volume</p>
                  </div>
                </div>

                {catalysts[stock.symbol] && (
                  <div className="bg-slate-800 border-l-2 border-emerald-500 p-3 rounded text-sm text-slate-300">
                    <p className="flex gap-2">
                      <AlertCircle className="w-4 h-4 text-emerald-500 flex-shrink-0 mt-0.5" />
                      <span>{catalysts[stock.symbol]}</span>
                    </p>
                  </div>
                )}

                {stock.newsCount > 0 && (
                  <p className="text-xs text-slate-400 mt-2">📰 {stock.newsCount} recent news items</p>
                )}
              </div>
            ))
          ) : (
            <div className="bg-slate-900 border border-slate-700 rounded-lg p-8 text-center text-slate-400">
              {marketStatus === 'closed' ? (
                <p>Market is closed. Check back during trading hours (9:30 AM - 4:00 PM EST)</p>
              ) : (
                <p>No stocks with >200% relative volume detected yet</p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="mt-8 pt-6 border-t border-slate-700 text-xs text-slate-500">
          <p>• Relative volume threshold: 200% of 30-day average</p>
          <p>• Scans first 30 minutes of market open</p>
          <p>• Updates every 5 minutes during market hours</p>
          <p>• Catalysts identified via Finnhub news + Claude analysis</p>
        </div>
      </div>
    </div>
  );
}
