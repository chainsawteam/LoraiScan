const path = require('path');
const express = require('express');
const cors = require('cors');

function normalizeTimestamp(row) {
  if (!row || !row.Finish) {
    return row;
  }

  return {
    ...row,
    Finish: new Date(row.Finish).getTime()
  };
}

function parsePagination(query, defaultLimit = 100) {
  const page = Math.max(1, parseInt(query.page || '1', 10) || 1);
  const limit = Math.max(1, Math.min(1000, parseInt(query.limit || String(defaultLimit), 10) || defaultLimit));
  return {
    page,
    limit,
    offset: (page - 1) * limit
  };
}

function createApp({ tokenRepository, tokenTable, loraRepository, serverConfig, chainConfig }) {
  const app = express();

  app.use(cors());
  app.use(express.json());

  if (serverConfig.serveStatic) {
    app.use(express.static(path.resolve(__dirname, '../../')));
  }

  app.get('/api/tokens', async (req, res) => {
    try {
      const pagination = parsePagination(req.query);
      const result = await tokenRepository.listTokens(tokenTable, {
        search: req.query.search || '',
        state: req.query.state || '',
        sortField: req.query.sortField || 'Id',
        sortDirection: req.query.sortDirection || 'asc',
        limit: pagination.limit,
        offset: pagination.offset
      });
      res.json({
        success: true,
        data: result.rows.map(normalizeTimestamp),
        pagination: {
          currentPage: pagination.page,
          limit: pagination.limit,
          total: result.total,
          totalPages: Math.ceil(result.total / pagination.limit)
        }
      });
    } catch (error) {
      res.status(500).json({ success: false, message: '服务器错误', error: error.message });
    }
  });

  app.get('/api/tokens/:id', async (req, res) => {
    try {
      const token = await tokenRepository.getTokenById(tokenTable, req.params.id);
      if (!token) {
        return res.status(404).json({ success: false, message: 'Token not found' });
      }
      res.json({ success: true, data: normalizeTimestamp(token) });
    } catch (error) {
      res.status(500).json({ success: false, message: '服务器错误', error: error.message });
    }
  });

  app.put('/api/tokens/:id/state', async (req, res) => {
    try {
      const { state } = req.body;
      if (state !== 0 && state !== 1) {
        return res.status(400).json({ success: false, message: '状态值必须是0或1' });
      }
      const affected = await tokenRepository.updateTokenState(tokenTable, req.params.id, state);
      if (!affected) {
        return res.status(404).json({ success: false, message: 'Token not found' });
      }
      res.json({ success: true, message: '状态更新成功' });
    } catch (error) {
      res.status(500).json({ success: false, message: '服务器错误', error: error.message });
    }
  });

  app.put('/api/tokens/:id/notes', async (req, res) => {
    try {
      const affected = await tokenRepository.updateTokenNotes(tokenTable, req.params.id, req.body.notes);
      if (!affected) {
        return res.status(404).json({ success: false, message: 'Token not found' });
      }
      res.json({ success: true, message: '备注更新成功' });
    } catch (error) {
      res.status(500).json({ success: false, message: '服务器错误', error: error.message });
    }
  });

  app.put('/api/tokens/batch/state', async (req, res) => {
    try {
      const { ids, state } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ success: false, message: 'ids必须是非空数组' });
      }
      if (state !== 0 && state !== 1) {
        return res.status(400).json({ success: false, message: '状态值必须是0或1' });
      }
      const affected = await tokenRepository.batchUpdateTokenState(tokenTable, ids, state);
      res.json({ success: true, message: `成功更新${affected}条记录` });
    } catch (error) {
      res.status(500).json({ success: false, message: '服务器错误', error: error.message });
    }
  });

  app.get('/api/stats', async (req, res) => {
    try {
      res.json({ success: true, data: await tokenRepository.getTokenStats(tokenTable) });
    } catch (error) {
      res.status(500).json({ success: false, message: '服务器错误', error: error.message });
    }
  });

  app.get('/api/notifications', async (req, res) => {
    try {
      const pagination = parsePagination(req.query);
      const result = await loraRepository.listNotifications({
        ...req.query,
        limit: pagination.limit,
        offset: pagination.offset
      });
      res.json({
        success: true,
        data: result.rows,
        pagination: {
          currentPage: pagination.page,
          limit: pagination.limit,
          total: result.total,
          totalPages: Math.ceil(result.total / pagination.limit)
        }
      });
    } catch (error) {
      res.status(500).json({ success: false, message: '服务器错误', error: error.message });
    }
  });

  app.get('/api/notifications/stats', async (req, res) => {
    try {
      res.json({ success: true, data: await loraRepository.getNotificationStats() });
    } catch (error) {
      res.status(500).json({ success: false, message: '服务器错误', error: error.message });
    }
  });

  app.put('/api/notifications/viewed/all', async (req, res) => {
    try {
      const affected = await loraRepository.markNotificationsViewedByFilter(req.body || {});
      res.json({ success: true, message: `成功更新${affected}条记录` });
    } catch (error) {
      res.status(500).json({ success: false, message: '服务器错误', error: error.message });
    }
  });

  app.get('/api/notifications/:id', async (req, res) => {
    try {
      const row = await loraRepository.getNotificationById(req.params.id);
      if (!row) {
        return res.status(404).json({ success: false, message: 'Notification not found' });
      }
      res.json({ success: true, data: row });
    } catch (error) {
      res.status(500).json({ success: false, message: '服务器错误', error: error.message });
    }
  });

  app.put('/api/notifications/:id/viewed', async (req, res) => {
    try {
      const { is_viewed } = req.body;
      if (is_viewed !== 0 && is_viewed !== 1) {
        return res.status(400).json({ success: false, message: 'is_viewed值必须是0或1' });
      }
      const affected = await loraRepository.updateNotificationViewed(req.params.id, is_viewed);
      if (!affected) {
        return res.status(404).json({ success: false, message: 'Notification not found' });
      }
      res.json({ success: true, message: '状态更新成功' });
    } catch (error) {
      res.status(500).json({ success: false, message: '服务器错误', error: error.message });
    }
  });

  app.put('/api/notifications/:id/remark', async (req, res) => {
    try {
      const affected = await loraRepository.updateNotificationRemark(req.params.id, req.body.remark);
      if (!affected) {
        return res.status(404).json({ success: false, message: 'Notification not found' });
      }
      res.json({ success: true, message: '备注更新成功' });
    } catch (error) {
      res.status(500).json({ success: false, message: '服务器错误', error: error.message });
    }
  });

  app.put('/api/notifications/batch/viewed', async (req, res) => {
    try {
      const { ids, is_viewed } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ success: false, message: 'ids必须是非空数组' });
      }
      if (is_viewed !== 0 && is_viewed !== 1) {
        return res.status(400).json({ success: false, message: 'is_viewed值必须是0或1' });
      }
      const affected = await loraRepository.batchUpdateNotificationViewed(ids, is_viewed);
      res.json({ success: true, message: `成功更新${affected}条记录` });
    } catch (error) {
      res.status(500).json({ success: false, message: '服务器错误', error: error.message });
    }
  });

  app.get('/api/contracts/stats', async (req, res) => {
    try {
      res.json({ success: true, data: await loraRepository.getContractStats() });
    } catch (error) {
      res.status(500).json({ success: false, message: '服务器错误', error: error.message });
    }
  });

  app.get('/api/contracts', async (req, res) => {
    try {
      const pagination = parsePagination(req.query);
      const result = await loraRepository.listContracts({
        ...req.query,
        limit: pagination.limit,
        offset: pagination.offset
      });
      res.json({
        success: true,
        data: result.rows,
        pagination: {
          currentPage: pagination.page,
          limit: pagination.limit,
          total: result.total,
          totalPages: Math.ceil(result.total / pagination.limit)
        }
      });
    } catch (error) {
      res.status(500).json({ success: false, message: '服务器错误', error: error.message });
    }
  });

  app.get('/api/contracts/:id', async (req, res) => {
    try {
      const row = await loraRepository.getContractById(req.params.id);
      if (!row) {
        return res.status(404).json({ success: false, message: 'Contract not found' });
      }
      res.json({ success: true, data: row });
    } catch (error) {
      res.status(500).json({ success: false, message: '服务器错误', error: error.message });
    }
  });

  app.put('/api/contracts/:id/status', async (req, res) => {
    try {
      const { status } = req.body;
      if (!status || !['pending', 'analyzed', 'invalid'].includes(status)) {
        return res.status(400).json({ success: false, message: '无效的状态值' });
      }
      await loraRepository.updateContractStatus(req.params.id, status);
      res.json({ success: true, message: '状态已更新' });
    } catch (error) {
      res.status(500).json({ success: false, message: '服务器错误', error: error.message });
    }
  });

  app.put('/api/contracts/:id/viewed', async (req, res) => {
    try {
      const { is_viewed } = req.body;
      if (is_viewed !== 0 && is_viewed !== 1) {
        return res.status(400).json({ success: false, message: 'is_viewed值必须是0或1' });
      }
      const affected = await loraRepository.updateContractViewed(req.params.id, is_viewed);
      if (!affected) {
        return res.status(404).json({ success: false, message: 'Contract not found' });
      }
      res.json({ success: true, message: '状态更新成功' });
    } catch (error) {
      res.status(500).json({ success: false, message: '服务器错误', error: error.message });
    }
  });

  app.put('/api/contracts/:id/remark', async (req, res) => {
    try {
      const affected = await loraRepository.updateContractRemark(req.params.id, req.body.remark);
      if (!affected) {
        return res.status(404).json({ success: false, message: 'Contract not found' });
      }
      res.json({ success: true, message: '备注更新成功' });
    } catch (error) {
      res.status(500).json({ success: false, message: '服务器错误', error: error.message });
    }
  });

  app.get('/api/contracts/:id/functions', async (req, res) => {
    try {
      res.json({ success: true, data: await loraRepository.getContractFunctions(req.params.id, req.query) });
    } catch (error) {
      res.status(500).json({ success: false, message: '服务器错误', error: error.message });
    }
  });

  app.get('/api/health', async (req, res) => {
    try {
      await tokenRepository.testConnection();
      res.json({
        success: true,
        message: '服务器运行正常',
        database: '数据库连接正常',
        chain: chainConfig.key,
        tokenTable,
        backgroundTasks: serverConfig.enableBackgroundTasks,
        dryRun: serverConfig.dryRun,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      res.status(500).json({ success: false, message: '数据库连接失败', error: error.message });
    }
  });

  app.get('/', (req, res) => {
    res.sendFile(path.resolve(__dirname, '../../index.html'));
  });

  app.use((err, req, res, next) => {
    console.error('未处理的错误:', err);
    res.status(500).json({
      success: false,
      message: '服务器内部错误',
      error: process.env.NODE_ENV === 'development' ? err.message : '服务器错误'
    });
  });

  app.use((req, res) => {
    res.status(404).json({ success: false, message: '接口不存在' });
  });

  return app;
}

module.exports = createApp;
