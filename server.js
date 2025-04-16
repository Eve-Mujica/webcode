console.log('视频上传服务已启动');

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const multer = require('multer');
const iconv = require('iconv-lite'); // 需要安装

const app = express();
const port = 3000;
const videosDir = path.join(__dirname, 'videos');

const options = {
  key: fs.readFileSync('/etc/letsencrypt/live/sakikobird.cn/privkey.pem'),
  cert: fs.readFileSync('/etc/letsencrypt/live/sakikobird.cn/fullchain.pem')
};

//const LocalHost = 'localhost';
// const LocalHost = '154.9.252.117';
const LocalHost = 'sakikobird.cn';

// 初始化内存存储
let videoData = new Map();

const UPLOAD_TEMP_DIR = path.join(__dirname, 'temp_uploads');
const MAX_TEMP_AGE = 3600_000;

// 定义播放次数存储文件的路径
const playCountsPath = path.join(videosDir, 'playCounts.json');

const minLevel = 1; // 设置最小权限等级

// 确保目录存在
fs.mkdirSync(videosDir, { recursive: true });
fs.mkdirSync(UPLOAD_TEMP_DIR, { recursive: true });

// 文件名映射配置
// const mapName = {
//   '荒漠迷城': '荒漠迷城',
//   '炼狱小镇': '炼狱小镇',
//   '远古遗迹': '远古遗迹',
//   '阿努比斯': '阿努比斯',
//   '核子危机': '核子危机'
// };

app.set('trust proxy', 1); // 信任第一个代理（如 Nginx）

const session = require('express-session');

// 添加 session 中间件，设置持久化 cookie（例如 7 天有效）
// const MongoStore = require('connect-mongo');

const { Sequelize } = require('sequelize');
const SequelizeStore = require('connect-session-sequelize')(session.Store);

// 初始化 Sequelize 连接（替换为你的数据库配置）
const sequelize = new Sequelize({
  database: 'your_database',
  username: 'eeschey',
  password: 'mysqlpasswordees',
  host: '127.0.0.1',
  dialect: 'mariadb', // 可选：mysql、postgres、sqlite 等
  port: 3306,
  logging: false, // 关闭所有 SQL 日志
});

// 配置 Session 存储到 Sequelize
const sessionStore = new SequelizeStore({
  db: sequelize,
  tableName: 'sessions', // 存储 session 的表名
  checkExpirationInterval: 15 * 60 * 1000, // 自动清理过期 session 的间隔（毫秒）
  expiration: 24 * 60 * 60 * 1000, // session 过期时间（默认 24 小时）
});

// 同步 Session 表（如果表不存在则自动创建）
sessionStore.sync();

app.use(session({
    secret: 'your-secret-key',
    resave: false,
    saveUninitialized: false,
    // store: MongoStore.create({
    //   mongoUrl: `mongodb://localhost:27017/session`, // 替换为你的 MongoDB 地址
    //   collectionName: 'sessions',
    //   autoRemove: 'native', // 自动清理过期的 session
    //   //stringify: false // 确保 session 数据不会被二次 JSON 序列化
    // }),
    store: sessionStore,
    cookie: { 
      maxAge: 10 * 12 * 30 * 24 * 60 * 60 * 1000, // 10年
      secure: true,          // HTTPS 下必须设置 secure:true
      sameSite: 'none'       // 跨端口或跨子域时建议设置 sameSite 为 'none'
    }
}));

// 中间件配置
const allowedOrigins = ['https://sakikobird.cn', 'https://sakikobird.cn:4000'];

app.use(cors({
  origin: function(origin, callback) {
    // 如果请求没有 origin（如 Postman）或 origin 在白名单中
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'x-upload-id'],
  exposedHeaders: ['Content-Length', 'Content-Range'],
  optionsSuccessStatus: 200
}));

// 提供 JSON 解析的中间件供 POST /login 使用
app.use(express.json());

// 登录页面路由（返回静态 login.html 页面，需在项目根目录放置）
app.get('/login', (req, res) => {
    res.sendFile(path.join(__dirname, 'login.html'));
});

// 登录处理接口
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  let user = null;
  if (username === 'admin' && password === '5T9LZ2Q8R7A3') {
    user = { username, level: 2 };
  } else if (username === 'user' && password === 'sakikobirduserpassword') {
    user = { username, level: 1 };
  } else {
    return res.status(401).json({ error: '登录失败' });
  }

  req.session.user = user;
  console.log('设置 session.user:', req.session); // 添加日志
  req.session.save(err => {
    if (err) {
      console.error('保存 session 失败:', err);
      return res.status(500).json({ error: 'Session 保存失败' });
    }
    console.log('登录成功, session.user:', req.session.user);
    res.json({ success: true, user });
  });
});

// 获取当前登录用户信息接口
app.get('/api/currentUser', (req, res) => {
  try {
    if (req.session && req.session.user) {
      const username = req.session.user.username;
      // 从 favoritesData 中读取该用户的视频收藏数据，如果没有则为空对象
      const videoFavorites = favoritesData[username] || {};
      // 将 videoFavorites 添加到返回的 user 对象中
      res.json({ user: { ...req.session.user, videoFavorites } });
    } else {
      res.json({ user: null });
    }
  } catch (err) {
    console.error('获取当前登录用户信息失败:', err);
    res.status(500).json({ error: '获取用户信息失败' });
  }
});

// 注销接口：销毁 session 并清除 Cookie
app.post('/logout', (req, res) => {
  console.log("POST /logout 被调用");
  try {
    req.session.destroy(err => {
      if (err) {
        console.error('注销失败:', err);
        return res.status(500).json({ error: '注销失败' });
      }
      res.clearCookie('connect.sid', { path: '/' });
      console.log('注销成功，session 已销毁');
      res.json({ success: true });
    });
  } catch (err) {
    console.error('注销时捕获到异常:', err);
    res.status(500).json({ error: '注销异常' });
  }
});

// 验证权限的中间件
function requireAuth(minLevel) {
  return (req, res, next) => {
    // 直接打印 req.session，避免 JSON.stringify 导致的错误
    if(minLevel === 0) next(); // 当权限需求为0时，允许所有人访问
    // console.log('权限验证: req.session =', req.session);
    else {
      if (req.session && req.session.user && req.session.user.level >= minLevel) {
        next();
      } else {
        res.status(403).json({ error: '无权限操作' });
      }
    }
  };
}

app.post('/api/videos/:id/move', express.json(), async (req, res) => {
  const videoId = req.params.id;
  const { series, subSeries } = req.body;
  console.log('移动视频请求:', videoId, series, subSeries);
  if (!series || !subSeries) {
      return res.status(400).json({ error: '缺少系列或子系列参数' });
  }
  const video = videoData.get(videoId);
  if (!video) return res.status(404).json({ error: '视频不存在' });
  if (video.series !== series) {
    const oldPath = path.join(videosDir, video.filename);
    const newPath = path.join(videosDir, series, path.basename(video.filename));// 确保目标目录存在      
    await fs.promises.mkdir(path.join(videosDir, series), { recursive: true });
      try { 
          await fs.promises.rename(oldPath, newPath); 
      } 
      catch (err) { 
          console.error('文件移动失败:', err);
          return res.status(500).json({ error: '文件移动失败' });
      }

      video.series = series;
      video.filename = path.join(series, path.basename(video.filename));
      video.url = `https://${LocalHost}:${port}/videos/${series}/${path.basename(video.filename)}`;
      //video.url = `http://${LocalHost}:${port}/videos/${series}/${path.basename(video.filename)}`;
  }

  // 清除该视频在所属系列所有子系列中的记录
  if (subSeriesMapping[series]) {
      Object.keys(subSeriesMapping[series]).forEach(sub => {
          subSeriesMapping[series][sub] = subSeriesMapping[series][sub].filter(id => id !== videoId);
      });
  } else {
      subSeriesMapping[series] = {};
  }
  // 将视频加入目标子系列（不存在则自动创建）
  if (!subSeriesMapping[series][subSeries]) {
      subSeriesMapping[series][subSeries] = [];
  }
  subSeriesMapping[series][subSeries].push(videoId);
  // 强制将子系列转换成字符串再保存
  video.subSeries = subSeries.toString();
  
  // 持久化元数据
  persistVideoData();
  
  res.json({ success: true, video, subSeriesMapping: subSeriesMapping[series] });
});

//配置文件上传中间件
const uploadVideo = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, UPLOAD_TEMP_DIR); // 临时存储目录
    },
    filename: (req, file, cb) => {
      const originalname = iconv.decode(Buffer.from(file.originalname, 'binary'), 'utf8');
      file.originalname = originalname;
      console.log('上传文件名:', originalname);
      cb(null, originalname); // 保留原始文件名
    }
  }),
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['video/mp4', 'video/webm', 'video/mkv'];
    allowedTypes.includes(file.mimetype) ? 
      cb(null, true) : 
      cb(new Error('仅支持 MP4/WebM/mkv 视频文件'), false);
  }
}).single('video');

// 修改后的上传文件路由
const ffmpeg = require('fluent-ffmpeg');
//const { console } = require('inspector');

app.post('/upload', requireAuth(minLevel),
  uploadVideo,  // 解析视频文件字段
  async (req, res) => {
    try {
      const series = req.body.series;
      const subseries = req.body.subSeries;
      const order = req.body.order || -1; // 默认值为 -1
      const playcount = req.body.playCount || 0; // 默认值为 0
      //console.log('上传视频请求:', series, subseries, order, req.body.order);
      if (!series) {
        return res.status(400).json({ error: '无效的系列ID' });
      }
      if (!req.file) {
        return res.status(400).json({ error: '未接收到视频文件' });
      }

      const seriesDir = path.join(videosDir, series);
      await fs.promises.mkdir(seriesDir, { recursive: true });

      // 获取原始文件名、扩展名以及不带扩展名的名称
      let originalName = req.file.originalname;
      const ext = path.extname(originalName);
      const baseName = path.basename(originalName, ext);
      // 正则表达式：匹配末尾 _UUID，UUID格式为8-4-4-4-12（不区分大小写）
      const uuidRegex = /_([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
      let uuid;
      if (uuidRegex.test(baseName)) {
        // 文件名已包含 UUID，则直接使用该 UUID，不生成新的、也不重命名
        uuid = baseName.match(uuidRegex)[1];
      } else {
        // 文件名末尾不包含 UUID，则生成新 UUID，并追加到文件名末尾
        uuid = crypto.randomUUID();
        originalName = `${baseName}_${uuid}${ext}`;
      }

      // 检查文件名唯一性
      let finalPath = path.join(seriesDir, originalName);
      let count = 1;
      while (fs.existsSync(finalPath)) {
        originalName = `${baseName}_${uuid}(${count})${ext}`;
        finalPath = path.join(seriesDir, originalName);
        count++;
      }

      // 移动上传的临时文件到正式目录
      await fs.promises.rename(req.file.path, finalPath);

      // 定义用于显示的名称（去除末尾 _UUID 部分）
      const displayName = baseName.replace(uuidRegex, '');

      // 可根据需要通过 ffprobe 检测视频属性
      ffmpeg.ffprobe(finalPath, (err, metadata) => {
        if (err) {
          console.error('ffprobe 检测失败:', err);
          completeUpload(finalPath, metadata);
        } else {
          const videoStream = metadata.streams.find(s => s.codec_type === 'video');
          let needCompression = false;
          let targetBitrate = null;
          let targetFps = null;

          if (videoStream) {
            const bitrate = parseInt(metadata.format.bit_rate, 10);
            if (bitrate > 50000000) { // 40 Mbps 阈值
              targetBitrate = '50000k';
              needCompression = true;
            }
            if (videoStream.avg_frame_rate && videoStream.avg_frame_rate.includes('/')) {
              const parts = videoStream.avg_frame_rate.split('/');
              const fps = parseFloat(parts[0]) / parseFloat(parts[1]);
              if (fps > 30) {
                targetFps = 30;
                needCompression = true;
              }
            }
          }

          if (needCompression) {
            const compressedPath = finalPath.replace(/(\.[^.]*)$/, '_compressed$1');
            console.log('开始压缩视频，目标码率:', targetBitrate, '目标帧率:', targetFps);
            let command = ffmpeg(finalPath)
              .videoCodec('libx264')
              .outputOptions('-preset', 'fast');
            if (targetBitrate) {
              command = command.videoBitrate(targetBitrate);
            }
            if (targetFps) {
              command = command.fps(targetFps);
            }
            command
              .on('end', async () => {
                await fs.promises.rename(compressedPath, finalPath);
                completeUpload(finalPath, metadata);
              })
              .on('error', (err) => {
                console.error('视频压缩错误:', err);
                completeUpload(finalPath, metadata);
              })
              .save(compressedPath);
          } else {
            completeUpload(finalPath, metadata);
          }
        }
      });

      async function completeUpload(finalPath, metadata = null) {
        let bitrate = "未知";
        if (metadata && metadata.format && metadata.format.bit_rate) {
          const bit = parseInt(metadata.format.bit_rate, 10);
          bitrate = Math.round(bit / 1000000);
        }
        videoData.set(uuid, {
          id: uuid,
          filename: path.join(series, originalName),
          series: series,
          playCount: playcount,
          lastModified: (await fs.promises.stat(finalPath)).mtimeMs,
          displayName: displayName,
          bitrate: bitrate,
          subSeries: subseries,
          order: order
        });
        persistVideoData();
        res.json({
          id: uuid,
          filename: originalName,
          path: `/videos/${series}/${originalName}`
        });
      }
    } catch (err) {
      console.error('上传处理失败:', err);
      if (req.file?.path) {
        try { await fs.promises.unlink(req.file.path); } catch(e){ }
      }
      res.status(500).json({ error: '文件保存失败' });
    }
  }
);

app.delete('/cleanup-upload', (req, res) => {
  console.log('清理上传请求：删除所有临时文件');
  fs.readdir(UPLOAD_TEMP_DIR, (err, files) => {
      if (err) {
          return res.status(500).send('无法读取临时目录');
      }
      if (files.length === 0) {
          return res.status(404).send('没有临时文件');
      }
      let deleteCount = 0;
      files.forEach(file => {
          fs.unlink(path.join(UPLOAD_TEMP_DIR, file), (err) => {
              if (!err) deleteCount++;
              // 当已处理所有文件后返回成功响应
              if (deleteCount === files.length) {
                  res.status(200).send(`已删除 ${deleteCount} 个文件`);
              }
          });
      });
  });
});

app.delete('/api/videos/:id', requireAuth(minLevel), (req, res) => {
    try {
        const videoId = req.params.id;
        const video = videoData.get(videoId);
        if (!video) {
            return res.status(404).json({ error: '视频不存在' });
        }
        const filePath = path.join(videosDir, video.filename);
        fs.unlink(filePath, (err) => {
            if (err) {
                console.error('删除视频文件失败:', err);
                return res.status(500).json({ error: '删除视频文件失败' });
            }
            // 从内存中移除该视频
            videoData.delete(videoId);
            // 持久化修改后的元数据
            persistVideoData();
            res.json({ success: true });
        });
    } catch (err) { 
        console.error('删除视频失败:', err);
    }
  
});

// 修改后的视频列表接口：检测到缺失元数据则生成新的 UUID 和默认元数据
app.get('/api/videos', async (req, res) => {
  console.log('开始加载视频列表');
  let persistedVideos = [];
  try {
    if (fs.existsSync(metadataPath)) {
      const data = await fs.promises.readFile(metadataPath, 'utf-8');
      persistedVideos = JSON.parse(data);
    }
  } catch (err) {
    console.error('读取元数据失败:', err);
  }

  // 使用文件完整路径（series/filename）建立持久化映射
  const persistedMap = new Map(persistedVideos.map(video => [video.filename, video]));
  //console.log('持久化映射:', persistedMap);

  const newVideoData = new Map();
  const uuidRegex = /_([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;

  // 遍历所有系列目录
  const seriesDirs = fs.readdirSync(videosDir, { withFileTypes: true }).filter(dirent => dirent.isDirectory());
  for (const dirent of seriesDirs) {
    const seriesName = dirent.name;
    const seriesPath = path.join(videosDir, seriesName);
    const files = fs.readdirSync(seriesPath);
    for (let file of files) {
      const ext = path.extname(file).toLowerCase();
      if (!['.mp4', '.webm', '.ogg'].includes(ext)) continue;

      let filePath = path.join(seriesPath, file);
      const stats = fs.statSync(filePath);
      let filenameKey = path.join(seriesName, file);
      
      //console.log(filenameKey);

      let video, id;
      // 如果在持久化数据中存在，则使用已有的 id
      if (persistedMap.has(filenameKey)) {
        video = persistedMap.get(filenameKey);
        id = video.id;
      } else {
        // 不存在时，从文件名中尝试提取 UUID
        const currentBaseName = path.basename(file, ext);
        const match = currentBaseName.match(uuidRegex);
        if (match) {
          id = match[1]; // 使用文件中已有的UUID
          const Old_filenamekey = findEntryById(persistedMap, id);
          if(Old_filenamekey) video = persistedMap.get(Old_filenamekey.filename);
          else video = { playCount: await Get_PlayCounts(id), subSeries: "默认子系列" };
        } else {
          // 文件名末尾不包含 UUID，则生成新的 UUID
          id = crypto.randomUUID();
          video = { playCount: 0, subSeries: "默认子系列" };
        }
      }
      //console.log(video);
      let currentBaseName = path.basename(file, ext);
      let baseName;
      if (uuidRegex.test(currentBaseName)) {
        // 文件名已包含 UUID，提取基础名称
        baseName = currentBaseName.replace(uuidRegex, '');
      } else {
        // 文件名末尾不包含 UUID，则追加 id 并重命名物理文件
        baseName = currentBaseName;
        const newFileName = `${baseName}_${id}${ext}`;
        const newFilePath = path.join(seriesPath, newFileName);
        try {
          await fs.promises.rename(filePath, newFilePath);
          //console.log(`已将文件 ${file} 重命名为 ${newFileName}`);
          // 更新变量
          file = newFileName;
          filePath = newFilePath;
          filenameKey = path.join(seriesName, newFileName);
        } catch (renameErr) {
          console.error('重命名文件失败:', renameErr);
        }
      }

      // 设置或更新视频数据记录，displayName 使用基础名称（不含 uuid）
      newVideoData.set(id, {
        id,
        filename: filenameKey,
        series: seriesName,
        displayName: video.displayName || baseName,
        url: `https://${LocalHost}:${port}/videos/${seriesName}/${file}`,
        // url: `http://${LocalHost}:${port}/videos/${seriesName}/${file}`,
        playCount: video.playCount,
        lastModified: stats.mtimeMs,
        subSeries: (video.subSeries !== undefined && video.subSeries !== null)
                   ? video.subSeries.toString()
                   : "默认子系列",
        bitrate: video.bitrate || "未知",
        order: video.order !== undefined ? video.order : null
      });
    }
  }

  videoData = newVideoData;
  persistVideoData();
  res.json({ videos: Array.from(videoData.values()) });

});


app.get('/api/videos/:id', handleVideoRequest);        // 不带显示名
app.get('/api/videos/:id/:displayName', handleVideoRequest); // 带显示名

function handleVideoRequest(req, res) {
    const videoId = req.params.id;
    const displayName = req.params.displayName; // 可能为 undefined
    console.error(displayName);
    const video = videoData.get(videoId);
    if (!video) {
        return res.status(404).json({ 
            error: 'NOT_FOUND',
            message: `视频 ${videoId} 不存在`
        });
    }

    // 如果URL包含显示名但不符合规范
    if (displayName && displayName !== video.displayNameSEO) {
        return res.redirect(301, `/videos/${videoId}/${video.displayNameSEO}`);
    }

    // 返回视频数据
    res.json(video);
}

// function formatDisplayName(filename) {
//     const displayName = filename
//         .replace(/\.[^/.]+$/, "")     // 移除扩展名
//         .replace(/^[^_]*_/, "")       // 移除系列前缀
//         .replace(/_/g, ' ')           // 下划线转空格
//         .replace(/\b\w/g, c => c.toUpperCase()); // 首字母大写
    
//     // 生成SEO友好名称
//     video.displayNameSEO = displayName
//         //.toLowerCase()
//         .replace(/\s+/g, '-')
//         .replace(/[^\w\u4e00-\u9fa5-]/g, '') // 匹配中文和基本字符
//         .replace(/--+/g, '-');
    
//     return displayName;
// }

// 静态文件服务
app.use('/videos', express.static(videosDir, {
  setHeaders: (res) => {
    res.header('Content-Type', 'video/mp4');
  }
}));

// 全局错误处理（新增）
app.use((err, req, res, next) => {
  console.error('服务器错误:', err.message);
  res.status(500).json({ 
    error: process.env.NODE_ENV === 'development' ? 
           err.message : 
           '服务器内部错误' 
  });
});

// 辅助函数
function formatDisplayName(filename) {
  return filename
    .replace(/\.[^/.]+$/, "")
    .replace(/^[^_]*_/, "")
    .replace(/^[^_]*_/, "")
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

const metadataPath = path.join(videosDir, 'metadata.json');

// 持久化 videoData 到磁盘
let isPersisting = false;
let pendingPersist = false;
function persistVideoData() {
    if (isPersisting) {
        pendingPersist = true;
        return;
    }
    //console.log(videoData);
    isPersisting = true;
    const videoArray = Array.from(videoData.values());
    const tempPath = metadataPath + '.tmp';
    fs.writeFile(tempPath, JSON.stringify(videoArray, null, 2), err => {
        if (err) {
            console.error('保存元数据失败:', err);
            isPersisting = false;
        } else {
            fs.rename(tempPath, metadataPath, renameErr => {
                if (renameErr) {
                    console.error('重命名元数据失败:', renameErr);
                } else {
                    //console.log('元数据已持久化');
                }
                isPersisting = false;
                if (pendingPersist) {
                    pendingPersist = false;
                    persistVideoData();
                }
            });
        }
    });
}

// 在服务器启动时加载元数据
async function loadVideoData() {
  console.log('开始加载元数据...');
  let persistedVideos = [];
  try {
    if (fs.existsSync(metadataPath)) {
      const data = await fs.promises.readFile(metadataPath, 'utf-8');
      persistedVideos = JSON.parse(data);
    }
    else{
      console.log('没有元数据文件，首次启动？');
    }
  } catch (err) {
    console.error('读取元数据失败:', err);
  }

  // 使用文件完整路径（series/filename）建立持久化映射
  const persistedMap = new Map(persistedVideos.map(video => [video.filename, video]));
  //console.log('持久化映射:', persistedMap);

  const newVideoData = new Map();
  const uuidRegex = /_([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;

  // 遍历所有系列目录
  const seriesDirs = fs.readdirSync(videosDir, { withFileTypes: true }).filter(dirent => dirent.isDirectory());
  for (const dirent of seriesDirs) {
    const seriesName = dirent.name;
    const seriesPath = path.join(videosDir, seriesName);
    const files = fs.readdirSync(seriesPath);
    for (let file of files) {
      const ext = path.extname(file).toLowerCase();
      if (!['.mp4', '.webm', '.ogg'].includes(ext)) continue;

      let filePath = path.join(seriesPath, file);
      const stats = fs.statSync(filePath);
      let filenameKey = path.join(seriesName, file);
      
      //console.log(filenameKey);

      let video, id;
      // 如果在持久化数据中存在，则使用已有的 id
      if (persistedMap.has(filenameKey)) {
        video = persistedMap.get(filenameKey);
        id = video.id;
      } else {
        // 不存在时，从文件名中尝试提取 UUID
        const currentBaseName = path.basename(file, ext);
        const match = currentBaseName.match(uuidRegex);
        if (match) {
          id = match[1]; // 使用文件中已有的UUID
          const Old_filenamekey = findEntryById(persistedMap, id);
          if(Old_filenamekey) video = persistedMap.get(Old_filenamekey.filename);
          else video = { playCount: await Get_PlayCounts(id), subSeries: "默认子系列" };
          //console.log('视频 ID:', id, '视频数据:', Get_PlayCounts(id));
        } else {
          // 文件名末尾不包含 UUID，则生成新的 UUID
          id = crypto.randomUUID();
          video = { playCount: 0, subSeries: "默认子系列" };
        }
      }
      //console.log(video);
      let currentBaseName = path.basename(file, ext);
      let baseName;
      if (uuidRegex.test(currentBaseName)) {
        // 文件名已包含 UUID，提取基础名称
        baseName = currentBaseName.replace(uuidRegex, '');
      } else {
        // 文件名末尾不包含 UUID，则追加 id 并重命名物理文件
        baseName = currentBaseName;
        const newFileName = `${baseName}_${id}${ext}`;
        const newFilePath = path.join(seriesPath, newFileName);
        try {
          await fs.promises.rename(filePath, newFilePath);
          //console.log(`已将文件 ${file} 重命名为 ${newFileName}`);
          // 更新变量
          file = newFileName;
          filePath = newFilePath;
          filenameKey = path.join(seriesName, newFileName);
        } catch (renameErr) {
          console.error('重命名文件失败:', renameErr);
        }
      }

      // 设置或更新视频数据记录，displayName 使用基础名称（不含 uuid）
      newVideoData.set(id, {
        id,
        filename: filenameKey,
        series: seriesName,
        displayName: video.displayName || baseName,
        url: `https://${LocalHost}:${port}/videos/${seriesName}/${file}`,
        // url: `http://${LocalHost}:${port}/videos/${seriesName}/${file}`,
        playCount: video.playCount,
        lastModified: stats.mtimeMs,
        subSeries: (video.subSeries !== undefined && video.subSeries !== null)
                   ? video.subSeries.toString()
                   : "默认子系列",
        bitrate: video.bitrate || "未知",
        order: video.order !== undefined ? video.order : null
      });
    }
  }

  videoData = newVideoData;
  persistVideoData();
}

async function calculateMissingBitrates() {
  console.log('开始计算缺失的码率...');
  for (const [id, video] of videoData.entries()) {
    if (!video.bitrate || video.bitrate === "未知") {
      const filePath = path.join(videosDir, video.filename);
      await new Promise((resolve) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
          if (err) {
            console.error(`计算 ${video.filename} 码率失败：`, err);
            return resolve();
          }
          if (metadata && metadata.format && metadata.format.bit_rate) {
            const bitrate = parseInt(metadata.format.bit_rate, 10);
            // 转换为 Mbps 字符串，例如 "2 Mbps"
            const Mbps = Math.round(bitrate / 1_000_000);
            video.bitrate = Mbps;
            console.log(`更新视频 ${video.displayName} 的码率为 ${Mbps} Mbps`);
          }
          resolve();
        });
      });
    }
  }
  // 更新持久化数据
  persistVideoData();
}

// 调用加载函数（放在 app.listen 前即可）
loadVideoData().then(() => {
  loadPlayCounts().then(() => {
    calculateMissingBitrates().then(() => {
      https.createServer(options, app).listen(port, () => {
        console.log(`服务器运行在 https://${LocalHost}:${port}`);
      });
    });
  });
});

// loadVideoData().then(() => {
//   loadPlayCounts().then(() => {
//     calculateMissingBitrates().then(() => {
//       http.createServer(app).listen(port, () => {
//         console.log(`服务器运行在 http://${LocalHost}:${port}`);
//       });
//     });
//   });
// });

http.createServer((req, res) => {
    res.writeHead(301, { "Location": "https://" + req.headers['host'] + req.url });
    res.end();
}).listen(8087);

setInterval(() => {
    fs.readdir(UPLOAD_TEMP_DIR, (err, files) => {
        if (err) return;
        const now = Date.now();
        files.forEach(file => {
            const filePath = path.join(UPLOAD_TEMP_DIR, file);
            fs.stat(filePath, (err, stats) => {
                if (!err && (now - stats.ctimeMs) > MAX_TEMP_AGE) {
                    fs.unlink(filePath, () => {});
                }
            });
        });
    });
}, MAX_TEMP_AGE);

const subSeriesMapping = {};

app.get('/api/subseries', (req, res) => {
  const series = req.query.series;
  if (!series) {
    return res.status(400).json({ error: '缺少系列参数' });
  }

  // 按子系列分组：以子系列名称为 key，值为该分组内的视频数组
  const subseriesMap = new Map();
  videoData.forEach(video => {
    if (video.series === series) {
      const sub = String(video.subSeries || "默认子系列").trim();
      if (!subseriesMap.has(sub)) {
        subseriesMap.set(sub, []);
      }
      subseriesMap.get(sub).push(video);
    }
  });

  // 生成结构化数组：先对每个子系列内部按视频名称排序
  const structuredSubseries = Array.from(subseriesMap, ([name, videos]) => {
    videos.sort((a, b) =>
      a.displayName.localeCompare(b.displayName, 'zh-CN', { numeric: true })
    );
    return { name: name.trim(), videos };
  });

  // 排序：将 "默认子系列" 放到最后，其它按名称排序
  const sortedSubseries = structuredSubseries.sort((a, b) => {
    const defaultName = "默认子系列";
    const hpname = "战术";
    const aName = a.name.trim();
    const bName = b.name.trim();
    //console.error(aName, bName);console.error(aName === defaultName, bName === defaultName);
    if (aName === defaultName && bName !== defaultName) {
      return 1; // a 放后
    }
    if (bName === defaultName && aName !== defaultName) {
      return -1; // b 放后
    }
    if (aName === hpname && bName !== hpname) {
      return -1; // b 放后
    }
    if (bName === hpname && aName !== hpname) {
      return 1; // a 放后
    }
    return aName.localeCompare(bName, 'zh-CN', { numeric: true });
  });
  
  res.json({ subSeries: sortedSubseries });
});

const commentsPath = path.join(videosDir, 'comments.json');
let commentsData = {};

// 加载评论数据
function loadCommentsData() {
    if (fs.existsSync(commentsPath)) {
        try {
            const data = fs.readFileSync(commentsPath, 'utf8');
            commentsData = JSON.parse(data);
            console.log('评论数据已加载');
        } catch (e) {
            console.error('加载评论数据失败:', e);
            commentsData = {};
        }
    } else {
        commentsData = {};
    }
}

// 持久化评论数据
function persistCommentsData() {
    fs.writeFile(commentsPath, JSON.stringify(commentsData, null, 2), err => {
        if (err) {
            console.error('保存评论数据失败:', err);
        } else {
            console.log('评论数据已持久化');
        }
    });
}

// 初始化加载评论数据
loadCommentsData();

// 获取视频评论接口
app.get('/api/comments/:videoId', (req, res) => {
    const videoId = req.params.videoId;
    const comments = commentsData[videoId] || [];
    res.json({ comments });
});

// 添加视频评论接口（无需登录）
app.post('/api/comments/:videoId', express.json(), (req, res) => {
    const videoId = req.params.videoId;
    const { content } = req.body;
    if (!content || content.trim() === '') {
        return res.status(400).json({ error: '评论内容不能为空' });
    }
    const newComment = {
        content: content.trim(),
        timestamp: Date.now()
    };
    if (!commentsData[videoId]) {
        commentsData[videoId] = [];
    }
    commentsData[videoId].push(newComment);
    persistCommentsData();
    res.json({ success: true, comment: newComment });
});

// 保存播放次数，将 videoData 中每个视频的 playCount 抽取出来写入文件
function persistPlayCounts() {
  const counts = {};
  videoData.forEach((video, id) => {
    counts[id] = video.playCount;
  });
  fs.writeFile(playCountsPath, JSON.stringify(counts, null, 2), err => {
    if (err) {
      console.error('保存播放次数失败:', err);
    } else {
      //console.log('播放次数已保存到', playCountsPath);
    }
  });
}

async function Get_PlayCounts(Video_UUID) {
    if (fs.existsSync(playCountsPath)) {
      try {
        //console.log(videoData);
        const data = await fs.promises.readFile(playCountsPath, 'utf-8');
        const counts = JSON.parse(data);
        for (const [id, count] of Object.entries(counts)) {
          if(id === Video_UUID) {
            return count;
          }
        }
        return 0; // 如果没有找到对应的播放次数，返回 0
        //console.log('播放次数数据加载成功');
      } catch (err) {
        console.error('寻找播放次数数据失败', err);
        return 0;
      }
    } else {  
      console.log('未找到播放次数数据文件');
      return 0;
    }
    return 0;
}

// 加载播放次数并更新 videoData 对应视频的 playCount
async function loadPlayCounts() {
  if (fs.existsSync(playCountsPath)) {
    try {
      //console.log(videoData);
      const data = await fs.promises.readFile(playCountsPath, 'utf-8');
      const counts = JSON.parse(data);
      for (const [id, count] of Object.entries(counts)) {
        //console.log(id, videoData.has(id));
        if (videoData.has(id)) {
          videoData.get(id).playCount = count;
        }
      }
      console.log('播放次数数据加载成功');
    } catch (err) {
      console.error('加载播放次数数据失败:', err);
    }
  } else {
    console.log('未找到播放次数数据文件');
  }
}

app.post('/api/videos/:id/increment-play', (req, res) => {
  const video = videoData.get(req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found' });
  
  video.playCount++;

  persistPlayCounts(); // 保存播放次数到单独的 JSON 文件
  persistVideoData(); // 同时保存到视频元数据文件
  res.json({ success: true, playCount: video.playCount });
});

// 重命名视频接口
app.post('/api/videos/:id/rename', express.json(), async (req, res) => {
  const videoId = req.params.id;
  const { newDisplayName } = req.body;
  
  if (!newDisplayName || newDisplayName.trim() === '') {
    return res.status(400).json({ error: '视频名称不能为空' });
  }
  
  const video = videoData.get(videoId);
  if (!video) {
    return res.status(404).json({ error: '视频不存在' });
  }
  
  // 更新视频显示名称
  video.displayName = newDisplayName.trim();
  
  // 生成 SEO 友好的名称（可根据需要调整规则）
  // video.displayNameSEO = newDisplayName.trim()
  //   .replace(/\s+/g, '-')
  //   .replace(/[^\w\u4e00-\u9fa5-]/g, '')
  //   .replace(/--+/g, '-');
  
  // 持久化修改后的元数据
  persistVideoData();
  
  res.json({ success: true, video });
});

// 直接重命名视频文件接口
app.post('/api/videos/:id/renameFile', express.json(), requireAuth(minLevel), async (req, res) => {
  const videoId = req.params.id;
  let { newFileName } = req.body;
  
  if (!newFileName || newFileName.trim() === '') {
    return res.status(400).json({ error: '文件名不能为空' });
  }
  newFileName = newFileName.trim();
  
  const video = videoData.get(videoId);
  if (!video) {
    return res.status(404).json({ error: '视频不存在' });
  }
  
  // 获取当前文件路径（视频存储路径为 videosDir/系列名/文件名）
  const oldPath = path.join(videosDir, video.filename);
  const ext = path.extname(oldPath);
  
  // 如果用户未输入扩展名，则自动追加现有扩展名
  if (path.extname(newFileName) === '') {
    newFileName += ext;
  }
  
  // 提取旧文件名（不含扩展名）中的 UUID 部分
  const oldBaseName = path.basename(video.filename, ext);
  const uuidRegex = /_([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
  let uuidPart = '';
  const match = oldBaseName.match(uuidRegex);
  if (match) {
    uuidPart = match[0]; // 包含前导下划线，例如 _xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
  }
  
  // 去掉用户新文件名中可能带有的扩展名（保证只修改显示名称部分）
  const newBaseName = path.basename(newFileName, ext);
  
  // 新文件名保留 uuid 后缀
  const finalFileName = uuidPart ? `${newBaseName}${uuidPart}${ext}` : `${newBaseName}${ext}`;
  
  // 构造新文件路径，确保在同一系列目录下
  const seriesDir = path.join(videosDir, video.series);
  const newPath = path.join(seriesDir, finalFileName);
  
  try {
    await fs.promises.rename(oldPath, newPath);
    // 更新 videoData 中对应的视频记录，保留 uuid 部分，仅更新 displayName 为新名称
    video.filename = path.join(video.series, finalFileName);
    video.displayName = newBaseName;
    
    // 持久化修改后的元数据
    persistVideoData();
    
    res.json({ success: true, video });
  } catch (err) {
    console.error('重命名视频文件失败:', err);
    res.status(500).json({ error: '重命名视频文件失败' });
  }
});


app.post('/api/subseries/rename', express.json(), requireAuth(minLevel), async (req, res) => {
  populateSubSeriesMapping(); // 确保映射已更新
  const { series, oldSub, newSub } = req.body;
  if (!series || !oldSub || !newSub) {
      return res.status(400).json({ error: '缺少系列、旧子系列或新子系列参数' });
  }
  //console.error('缺少参数:', req.body,subSeriesMapping);
  // 检查对应系列是否存在并包含旧子系列
  if (subSeriesMapping[series] && subSeriesMapping[series][oldSub]) {
      // 更新 subSeriesMapping
      const videoIds = subSeriesMapping[series][oldSub];
      // 如果目标子系列已存在，则可合并（这里简单覆盖）
      subSeriesMapping[series][newSub] = videoIds;
      delete subSeriesMapping[series][oldSub];
      // 更新 videoData 中对应视频的 subSeries 字段
      videoIds.forEach(id => {
          const video = videoData.get(id);
          if (video) {
              video.subSeries = newSub;
          }
      });
      persistVideoData();
      res.json({ success: true });
  } else {
      res.status(404).json({ error: '旧子系列不存在或系列不存在' });
  }
});

function populateSubSeriesMapping() {
  // 清空旧的映射
  Object.keys(subSeriesMapping).forEach(series => delete subSeriesMapping[series]);
  
  videoData.forEach(video => {
    const series = video.series;
    const sub = String(video.subSeries || "默认子系列").trim();
    if (!subSeriesMapping[series]) {
      subSeriesMapping[series] = {};
    }
    if (!subSeriesMapping[series][sub]) {
      subSeriesMapping[series][sub] = [];
    }
    subSeriesMapping[series][sub].push(video.id);
  });
  //console.log('重建的subSeriesMapping:', subSeriesMapping);
}

// 添加更改系列名的接口
app.post('/api/series/rename', express.json(), requireAuth(minLevel), async (req, res) => {
  const { oldName, newName } = req.body;
  
  if (!oldName || !newName || newName.trim() === '') {
    return res.status(400).json({ error: '系列名称不能为空' });
  }

  try {
    const oldPath = path.join(videosDir, oldName);
    const newPath = path.join(videosDir, newName);

    // 检查新文件夹名是否已存在
    if (fs.existsSync(newPath)) {
      return res.status(400).json({ error: '该系列名称已存在' });
    }

    // 重命名文件夹
    await fs.promises.rename(oldPath, newPath);

    // 更新 videoData 中所有相关视频的 series 和 filename
    for (const video of videoData.values()) {
      if (video.series === oldName) {
        video.series = newName;
        video.filename = video.filename.replace(oldName, newName);
        video.url = video.url.replace(`/videos/${oldName}/`, `/videos/${newName}/`);
      }
    }

    // 持久化更新后的元数据
    persistVideoData();

    res.json({ 
      success: true, 
      message: '系列名称已更新',
      updatedVideos: Array.from(videoData.values()).filter(v => v.series === newName)
    });

  } catch (err) {
    console.error('重命名系列失败:', err);
    res.status(500).json({ error: '重命名系列失败' });
  }
});

const cron = require('node-cron');

// 设置备份目录（videos/backups）并确保其存在
const backupDir = path.join(videosDir, 'backups');
fs.mkdirSync(backupDir, { recursive: true });

async function backupData() {
  const dateStr = new Date().toISOString().slice(0, 10); // 格式 YYYY-MM-DD
  const metadataBackup = path.join(backupDir, `metadata_${dateStr}.json`);
  const commentsBackup = path.join(backupDir, `comments_${dateStr}.json`);
  
  try {
    if (fs.existsSync(metadataPath)) {
      await fs.promises.copyFile(metadataPath, metadataBackup);
      console.log(`元数据已备份到: ${metadataBackup}`);
    } else {
      console.log('未找到元数据文件，跳过备份');
    }
    
    if (fs.existsSync(commentsPath)) {
      await fs.promises.copyFile(commentsPath, commentsBackup);
      console.log(`评论数据已备份到: ${commentsBackup}`);
    } else {
      console.log('未找到评论数据文件，跳过备份');
    }
  } catch (err) {
    console.error('备份失败:', err);
  }
}

app.put('/api/videos/order', express.json(), requireAuth(minLevel), async (req, res) => {
  const { series, subSeries, order } = req.body;
  if (!series || !subSeries || !Array.isArray(order)) {
    return res.status(400).json({ error: '缺少系列、子系列或排序数据' });
  }
  // 遍历传入的顺序数组，更新每个视频的 order 属性（仅限于指定系列和子系列内）
  order.forEach((videoId, index) => {
    const __video = videoData.get(videoId);
    if (__video && __video.series === series && __video.subSeries === subSeries) {
      __video.order = index;  // 数字越小排序越前面
      //console.log(`视频 ${videoId} 的排序已更新为 ${index}`);
    }
    //console.log('order函数内：', __video);
  });
  
  // 持久化更新后的元数据
  persistVideoData();
  res.json({ success: true });
});

// 使用 cron 表达式：每天凌晨 00:00 执行一次备份
cron.schedule('0 0 * * *', backupData);

function findEntryById(TargetMap, targetId) {
  for (const entry of TargetMap.values()) {
    if (entry.id === targetId) {
      //console.log(entry);
      return entry; // 返回匹配的对象
    }
  }
  return null; // 未找到
}

// 定义视频简介数据文件路径
const descriptionsPath = path.join(videosDir, 'descriptions.json');
let videoDescriptions = {};

// 加载视频简介数据
function loadDescriptionsData() {
  if (fs.existsSync(descriptionsPath)) {
    try {
      const data = fs.readFileSync(descriptionsPath, 'utf8');
      videoDescriptions = JSON.parse(data);
      console.log('视频简介数据已加载');
    } catch (e) {
      console.error('加载视频简介数据失败:', e);
      videoDescriptions = {};
    }
  } else {
    videoDescriptions = {};
  }
}

// 持久化视频简介数据
function persistDescriptionsData() {
  fs.writeFile(descriptionsPath, JSON.stringify(videoDescriptions, null, 2), err => {
    if (err) {
      console.error('保存视频简介数据失败:', err);
    } else {
      console.log('视频简介数据已持久化');
    }
  });
}

// 启动时加载简介数据
loadDescriptionsData();

// 获取指定视频简介的接口
app.get('/api/descriptions/:videoId', (req, res) => {
  const videoId = req.params.videoId;
  const description = videoDescriptions[videoId] || "";
  res.json({ videoId, description });
});

// 更新指定视频简介的接口
app.post('/api/descriptions/:videoId', express.json(), requireAuth(minLevel), (req, res) => {
  const videoId = req.params.videoId;
  const { description } = req.body;
  if (description === undefined) {
    return res.status(400).json({ error: '缺少简介内容' });
  }
  videoDescriptions[videoId] = description;
  persistDescriptionsData();
  res.json({ success: true, videoId, description });
});

// 定义系列信息数据文件路径
const seriesInfoPath = path.join(videosDir, 'seriesInfo.json');
let seriesInfoData = {};

// 加载系列信息数据
function loadSeriesInfoData() {
  if (fs.existsSync(seriesInfoPath)) {
    try {
      const data = fs.readFileSync(seriesInfoPath, 'utf8');
      seriesInfoData = JSON.parse(data);
      console.log('系列信息数据已加载');
    } catch (err) {
      console.error('加载系列信息数据失败:', err);
      seriesInfoData = {};
    }
  } else {
    seriesInfoData = {};
  }
}

// 持久化系列信息数据
function persistSeriesInfoData() {
  fs.writeFile(seriesInfoPath, JSON.stringify(seriesInfoData, null, 2), err => {
    if (err) {
      console.error('保存系列信息数据失败:', err);
    } else {
      console.log('系列信息数据已持久化');
    }
  });
}

// 启动时加载系列信息数据
loadSeriesInfoData();

// 获取所有系列额外信息的接口
app.get('/api/series-info', (req, res) => {
  res.json({ seriesInfo: seriesInfoData });
});

// 更新或修改某个系列额外信息的接口
app.post('/api/series-info', express.json(), requireAuth(minLevel), (req, res) => {
  const series = req.body.series;
  const info = req.body; // info 应为一个对象，包含系列的相关信息（如描述、创建日期等）
  console.log(info);
  if (typeof info !== 'object' || info === null) {
    return res.status(400).json({ error: '系列信息必须为对象' });
  }
  seriesInfoData[series] = info;
  persistSeriesInfoData();
  res.json({ success: true, series, info });
});


// 新增：加载和持久化视频高亮状态
const videoHighlightsPath = path.join(__dirname, 'videoHighlights.json');
let videoHighlights = {};

// 加载视频高亮数据
if (fs.existsSync(videoHighlightsPath)) {
    try {
        const data = fs.readFileSync(videoHighlightsPath, 'utf8');
        videoHighlights = JSON.parse(data);
        console.log('视频高亮数据已加载:', videoHighlights);
    } catch (err) {
        console.error('加载视频高亮数据失败:', err);
        videoHighlights = {};
    }
}

// 持久化视频高亮数据
function persistVideoHighlights() {
    fs.writeFile(videoHighlightsPath, JSON.stringify(videoHighlights, null, 2), err => {
        if (err) {
            console.error('保存视频高亮数据失败:', err);
        } else {
            console.log('视频高亮数据已保存');
        }
    });
}

// GET 接口：返回所有视频的高亮状态
app.get('/api/video-highlight', (req, res) => {
    res.json(videoHighlights);
});

// POST 接口：更新指定视频的高亮状态
app.post('/api/video-highlight', express.json(), (req, res) => {
    const { videoId, highlighted } = req.body;
    if (!videoId || typeof highlighted !== 'boolean') {
        return res.status(400).json({ error: '参数错误' });
    }
    videoHighlights[videoId] = highlighted;
    persistVideoHighlights();
    res.json({ success: true });
});

// --- 新增收藏数据处理 ---
// 定义收藏数据文件路径和数据对象，存储格式示例：
// { "用户名1": { "子系列名称1": true, "子系列名称2": false, ... }, "用户名2": { ... } }
const favoritesPath = path.join(__dirname, 'favorites.json');
let favoritesData = {};

// 加载收藏数据
function loadFavoritesData() {
  if (fs.existsSync(favoritesPath)) {
    try {
      const data = fs.readFileSync(favoritesPath, 'utf8');
      favoritesData = JSON.parse(data);
      console.log('收藏数据已加载');
    } catch (err) {
      console.error('加载收藏数据失败:', err);
      favoritesData = {};
    }
  } else {
    favoritesData = {};
  }
}
loadFavoritesData();

// 持久化收藏数据
function persistFavoritesData() {
  fs.writeFile(favoritesPath, JSON.stringify(favoritesData, null, 2), err => {
    if (err) {
      console.error('保存收藏数据失败:', err);
    } else {
      console.log('收藏数据已持久化');
    }
  });
}

// 获取当前登录用户的视频收藏数据
app.get('/api/favorites/video', (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: '未登录' });
  }
  const username = req.session.user.username;
  const userFavorites = favoritesData[username] || {};
  res.json(userFavorites);
});

// 更新当前登录用户的视频收藏状态
app.post('/api/favorites/video', express.json(), (req, res) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: '未登录' });
  }
  const username = req.session.user.username;
  const { videoId, favorited } = req.body;
  if (typeof videoId !== 'string' || typeof favorited !== 'boolean') {
    return res.status(400).json({ error: '参数错误' });
  }
  if (!favoritesData[username]) {
    favoritesData[username] = {};
  }
  favoritesData[username][videoId] = favorited;
  persistFavoritesData();
  res.json({ success: true, videoId, favorited });
});

app.put('/api/subseries/order', express.json(), requireAuth(minLevel), (req, res) => {
  const { series, order } = req.body;
  if (!series || !Array.isArray(order)) {
      return res.status(400).json({ error: '缺少系列或顺序数据' });
  }
  // 假设我们将子系列顺序保存在系列信息数据中（例如 seriesInfoData）
  if (!seriesInfoData[series]) {
      seriesInfoData[series] = {};
  }
  // 保存子系列顺序，例如：seriesInfoData[series].subseriesOrder = order;
  seriesInfoData[series].subseriesOrder = order;
  persistSeriesInfoData();
  console.log(`系列 ${series} 的子系列新顺序:`, order);
  res.json({ success: true });
});

// 新增历史播放数据的存储，存于history.json
const historyPath = path.join(__dirname, 'history.json');
let historyData = {};
if (fs.existsSync(historyPath)) {
  try {
    const data = fs.readFileSync(historyPath, 'utf8');
    historyData = JSON.parse(data);
    console.log('历史播放数据已加载');
  } catch (err) {
    console.error('加载历史播放数据失败:', err);
  }
} else {
  historyData = {};
}
function persistHistoryData() {
  fs.writeFile(historyPath, JSON.stringify(historyData, null, 2), err => {
    if (err) console.error('持久化历史播放数据失败:', err);
    else console.log('历史播放数据已保存');
  });
}

// 获取当前登录用户的历史播放数据
app.get('/api/history/video', (req, res) => {
  //console.log('获取历史播放数据...');
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: '未登录' });
  }
  const username = req.session.user.username;
  res.json(historyData[username] || {});
});

// 更新当前用户的历史播放（例如每次切换视频或退出时记录）
app.post('/api/history/video', express.json(), (req, res) => {
  
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: '未登录' });
  }
  const username = req.session.user.username;
  const { videoId, playedAt } = req.body;
  //console.log(req.body, historyData);
  // playbackTime：本次播放时长，playedAt：播放时间（时间戳）
  if (!videoId) {
    return res.status(400).json({ error: '参数错误' });
  }
  if (!historyData[username]) {
    historyData[username] = {};
  }
  // 更新记录，后续可扩展为多次播放记录
  historyData[username][videoId] = { playedAt: playedAt || Date.now() };
  
  persistHistoryData();
  res.json({ success: true });
});
// 服务器启动时加载元数据
// async function loadVideoData() {
//     try {
//         const metaPath = path.join(videosDir, 'metadata.json');
//         if (fs.existsSync(metaPath)) {
//             const data = await fs.promises.readFile(metaPath, 'utf-8');
//             const videos = JSON.parse(data);
//             videoData = new Map(videos.map(v => [v.id, v]));
//         }
//     } catch (err) {
//         console.error('加载元数据失败:', err);
//     }
// }



// 在服务器启动时调用
// loadVideoData().then(() => {
//     app.listen(port, () => {
//         console.log(`服务器运行在 http://${LocalHost}:${port}`);
//     });
// });

/*
sudo apt update && sudo apt install apache2 -y
sudo systemctl start apache2
sudo systemctl enable apache2
sudo apt install curl -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

npm install express
npm install cors
npm install iconv-lite
npm install express cors crypto
npm install express multer
npm install express-session --save
npm install express-session connect-session-sequelize
npm install sequelize
npm install mysql2
npm install mariadb

mysqlpasswordees


方法 2：使用 PowerShell 安装
1使用Windows + R快捷键打开「运行」对话框，输入powershell，然后按Ctrl + Shift + Enter以管理员权限打开 PowerShell 窗口。

2执行以下命令查看 OpenSSH 安装状态：

Get-WindowsCapability -Online | Where-Object Name -like 'OpenSSH*'
如果返回NotPresent，表示未安装；返回Installed则表示已安装。

3根据需要安装 OpenSSH 客户端和服务器组件：

# 安装 OpenSSH 客户端
Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0

# 安装 OpenSSH 服务器
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0


*/