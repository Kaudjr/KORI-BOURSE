import express from 'express';
import path from 'node:path';
import zlib from 'node:zlib';
import { createServer as createViteServer } from 'vite';
import {
  refreshBoc,
  uploadBocManual,
  getStoredBocRecords,
  getBocFilePath,
  initBocStorage,
} from './src/server/bocServer.ts';
import { extractBocDataFromPdf, getStoredExtraction } from './src/server/bocExtractor.ts';
import { computeBocFreshnessMessage, getExpectedSessionDate } from './src/utils/bocUtils.ts';
import { FundamentalsRepository } from './src/services/fundamentalsService.ts';
import { marketData, type HistoryRange } from './src/server/marketData.ts';

const VALID_RANGES: HistoryRange[] = ['1M', '3M', '1Y', 'MAX'];

function isHistoryRange(value: unknown): value is HistoryRange {
  return typeof value === 'string' && VALID_RANGES.includes(value as HistoryRange);
}

/** Compresse les réponses JSON > 1 Ko (les payloads marché font plusieurs centaines de Ko). */
function gzipJsonMiddleware() {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const originalJson = res.json.bind(res);

    res.json = ((body: unknown) => {
      if (res.headersSent) return res;

      const json = JSON.stringify(body);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('X-Powered-By', 'KORI-BOURSE');

      const acceptsGzip = /\bgzip\b/i.test(String(req.headers['accept-encoding'] ?? ''));
      if (acceptsGzip && json.length > 1024) {
        const compressed = zlib.gzipSync(json, { level: 6 });
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Content-Length', String(compressed.length));
        res.end(compressed);
        return res;
      }

      res.setHeader('Content-Length', String(Buffer.byteLength(json)));
      res.end(json);
      return res;
    }) as express.Response['json'];

    next();
  };
}

async function startServer() {
  const app = express();
  const port = Number(process.env.PORT || 3000);

  initBocStorage();
  app.use(express.json({ limit: '30mb' }));
  app.use(gzipJsonMiddleware());

  // ---------------------------------------------------------------------------
  // Marché : données consolidées, cache serveur, historique à la demande
  // ---------------------------------------------------------------------------

  // Tableau de bord complet (actions, indices, secteurs, breadth, palmarès)
  app.get('/api/market/dashboard', async (_req, res) => {
    try {
      const payload = await marketData.getDashboard();
      res.setHeader('Cache-Control', 'public, max-age=15, stale-while-revalidate=45');
      res.json(payload);
    } catch (err: any) {
      console.error('API dashboard error:', err);
      res.status(503).json({
        error: err.message || 'Données de marché indisponibles',
        status: marketData.getStatus(),
      });
    }
  });

  // Compatibilité : ancien endpoint (payload allégé, sans historique long)
  app.get('/api/market/all', async (_req, res) => {
    try {
      const payload = await marketData.getDashboard();
      res.setHeader('Cache-Control', 'public, max-age=15, stale-while-revalidate=45');
      res.json({
        stocks: payload.stocks,
        indices: payload.indices.map((index) => ({
          symbol: index.code,
          name: index.name,
          value: index.value,
          change: index.change,
          changePercent: index.changePercent,
          high: index.high,
          low: index.low,
          sparkline: index.sparkline,
        })),
        summary: {
          ...payload.summary,
          advancers: payload.summary.advancers,
          decliners: payload.summary.decliners,
          unchanged: payload.summary.unchanged,
          totalVolumeShares: payload.summary.totalVolumeShares,
          totalValueCFA: payload.summary.totalValueCFA,
          sourceInfo: payload.summary.sourceInfo,
        },
        meta: payload.meta,
      });
    } catch (err: any) {
      console.error('API Error:', err);
      res.status(503).json({ error: err.message || 'Failed to fetch market data' });
    }
  });

  // Historique d'un titre (?range=1M|3M|1Y|MAX)
  app.get('/api/market/history/:ticker', async (req, res) => {
    const ticker = String(req.params.ticker || '').toUpperCase();
    const range = isHistoryRange(req.query.range) ? req.query.range : '3M';
    try {
      const payload = await marketData.getStockHistory(ticker, range);
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.json(payload);
    } catch (err: any) {
      res.status(404).json({ error: err.message || `Historique introuvable pour ${ticker}` });
    }
  });

  // Historique d'un indice (?range=1M|3M|1Y|MAX)
  app.get('/api/market/index-history/:code', async (req, res) => {
    const code = String(req.params.code || '').toUpperCase();
    const range = isHistoryRange(req.query.range) ? req.query.range : '3M';
    try {
      const payload = await marketData.getIndexHistory(code, range);
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.json(payload);
    } catch (err: any) {
      res.status(404).json({ error: err.message || `Historique introuvable pour ${code}` });
    }
  });

  // Synchronisation forcée avec GitHub
  app.post('/api/market/refresh', async (_req, res) => {
    try {
      const payload = await marketData.forceRefresh();
      res.setHeader('Cache-Control', 'no-store');
      res.json(payload);
    } catch (err: any) {
      console.error('API refresh error:', err);
      res.status(503).json({ error: err.message || 'Synchronisation impossible', status: marketData.getStatus() });
    }
  });

  // État du moteur (progression, cache, commit)
  app.get('/api/market/status', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      status: marketData.getStatus(),
      cache: marketData.getCacheInfo(),
    });
  });

  // BOC Routes
  // 1. List recorded BOCs & freshness
  app.get('/api/boc/list', async (req, res) => {
    try {
      const records = getStoredBocRecords();
      const latest = records.length > 0 ? records[0] : null;
      const freshness = computeBocFreshnessMessage(latest ? latest.sessionDate : null);
      const expected = getExpectedSessionDate();
      res.json({
        records,
        expectedSessionDate: expected.sessionDate,
        expectedSessionFormatted: expected.sessionDateFormatted,
        freshnessMessage: freshness.message,
        isDelayed: freshness.isDelayed,
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message || 'Erreur lecture BOC' });
    }
  });

  // 2. Automatic refresh
  app.post('/api/boc/refresh', async (req, res) => {
    try {
      const result = await refreshBoc();
      res.json(result);
    } catch (err: any) {
      console.error('BOC Refresh error:', err);
      res.status(500).json({
        status: 'error',
        message: err.message || 'Erreur lors de la récupération du BOC',
      });
    }
  });

  // 3. Manual upload
  app.post('/api/boc/upload', async (req, res) => {
    try {
      const { fileName, fileBase64, sessionDate } = req.body;
      if (!fileName || !fileBase64) {
        return res.status(400).json({
          status: 'error',
          message: 'Nom de fichier et contenu base64 requis.',
        });
      }
      const result = await uploadBocManual(fileName, fileBase64, sessionDate);
      res.json(result);
    } catch (err: any) {
      console.error('BOC Upload error:', err);
      res.status(500).json({
        status: 'error',
        message: err.message || 'Erreur lors de l’import manuel du BOC',
      });
    }
  });

  // 4. Download / View PDF
  app.get('/api/boc/download/:fileName', (req, res) => {
    try {
      const fileName = req.params.fileName;
      const filePath = getBocFilePath(fileName);
      if (!filePath) {
        return res.status(404).send('Fichier BOC introuvable.');
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="${path.basename(filePath)}"`);
      res.sendFile(filePath);
    } catch (err: any) {
      res.status(500).send('Erreur lors du téléchargement du fichier.');
    }
  });

  // 5. Get extracted data for a session
  app.get('/api/boc/:date/extracted', async (req, res) => {
    try {
      const date = req.params.date;
      const cached = getStoredExtraction(date);
      if (cached) {
        return res.json(cached);
      }

      // Check if file exists for this session
      const records = getStoredBocRecords();
      const record = records.find((r) => r.sessionDate === date || r.id === date);
      if (!record) {
        return res.status(404).json({ error: `Aucun BOC enregistré pour la séance du ${date}.` });
      }

      // Extract on the fly if not yet cached
      const result = await extractBocDataFromPdf(record.fileName, false);
      res.json(result);
    } catch (err: any) {
      console.error('Error fetching extracted BOC data:', err);
      res.status(500).json({ error: err.message || 'Erreur lors de la lecture des données extraites' });
    }
  });

  // 6. Force re-extraction
  app.post('/api/boc/:date/extract', async (req, res) => {
    try {
      const date = req.params.date;
      const force = req.body?.force ?? true;
      const records = getStoredBocRecords();
      const record = records.find((r) => r.sessionDate === date || r.id === date);
      if (!record) {
        return res.status(404).json({ error: `Aucun BOC enregistré pour la séance du ${date}.` });
      }

      const result = await extractBocDataFromPdf(record.fileName, force);
      res.json(result);
    } catch (err: any) {
      console.error('Error extracting BOC data:', err);
      res.status(500).json({ error: err.message || 'Erreur lors de l’extraction Gemini' });
    }
  });

  // 7. Extract fundamentals
  app.post('/api/fundamentals/extract', express.json({limit: '50mb'}), async (req, res) => {
    try {
      const { ticker, exerciseYear, fileName, fileBase64 } = req.body;
      const pdfText = "Contenu extrait du PDF"; // In real server: pdfjs-dist extraction
      const stockInfo = { name: ticker }; // Or look up in ref

      const record = await FundamentalsRepository.extractFinancialsFromText(
        ticker,
        stockInfo.name,
        pdfText,
        exerciseYear,
        fileName
      );
      res.json(record);
    } catch (err: any) {
      console.error('Error extracting financials:', err);
      res.status(500).json({ error: err.message || 'Erreur lors de l’extraction Gemini' });
    }
  });

  // Diagnostic rapide du moteur de données
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      uptimeSeconds: Math.round(process.uptime()),
      market: {
        status: marketData.getStatus(),
        cache: marketData.getCacheInfo(),
      },
    });
  });

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'Endpoint API inconnu.' });
  });

  // En développement : Vite middleware. En production : build statique.
  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir, { maxAge: '1h', etag: true }));
    app.get('*', (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
  } else {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`KORI BOURSE · serveur prêt sur http://localhost:${port}`);
    // Précharge le cache marché sans bloquer le démarrage.
    marketData.start();
  });
}


startServer();
