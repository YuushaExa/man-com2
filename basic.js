import fs from 'fs/promises';
import * as fsSync from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import pLimit from 'p-limit';

// == Configuration ==
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const JSON_FILE = process.argv[2] || 'data.json';
const OPTIMIZE = process.argv[3] === 'true';
const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN || '';
const TG_CHAT_ID = process.env.TG_CHAT_ID || '';

// Concurrency settings (env-overridable)
const DOWNLOAD_CONCURRENCY = parseInt(process.env.DOWNLOAD_CONCURRENCY) || 8;
const OPTIMIZE_CONCURRENCY = parseInt(process.env.OPTIMIZE_CONCURRENCY) || 4;

// == Sharp WebP Settings ==
const WEBP_OPTIONS = {
  quality: 75,
  effort: 4,
  lossless: false,
  smartSubsample: true
};

// == Telegram Config ==
const TG_API = 'https://api.telegram.org/bot';
const TG_DELAY_MS = 3000;
const TARGET_ZIP_SIZE_BYTES = 45 * 1024 * 1024;

// == Logging State ==
const logs = {
  downloads: { success: 0, failed: [] },
  optimizations: { success: 0, failed: [] },
  chapters: { success: 0, failed: [] },
  telegram: { success: 0, failed: [] }
};

// == Helpers ==
function sanitize(str) {
  return (str || '').toString().replace(/[^a-zA-Z0-9._-]/g, '_');
}
function hasFailures() {
  return (
    logs.downloads.failed.length > 0 ||
    logs.optimizations.failed.length > 0 ||
    logs.telegram.failed.length > 0
  );
}
// ✅ FIXED: Always coerce to string before .replace()
function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ✅ Helper: normalize field to array of values
const toArray = (val) => {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    return val.split(',').map(s => s.trim()).filter(s => s);
  }
  return [val];
};

function extractMangaId(url) {
  if (!url) return 'N/A';
  try {
    const match = url.trim().match(/\/title\/([^-\s\/]+)/);
    return match ? match[1] : 'N/A';
  } catch {
    return 'N/A';
  }
}

// ✅ Better deduplication - strips punctuation & normalizes more aggressively
function dedupeChapters(chapters) {
  const seen = new Map();
  const deduped = [];
  
  for (const ch of chapters) {
    // Normalize: lowercase, remove ALL non-alphanumeric except spaces, collapse spaces, trim
    const nameKey = (ch.name || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')  // ← Remove ALL punctuation/special chars
      .replace(/\s+/g, ' ')
      .trim();
    
    const key = `${ch.number}|${nameKey}`;
    
    if (seen.has(key)) {
      console.log(`⚠️  Skipping duplicate: Ch${ch.number} "${ch.name}"`);
      continue;
    }
    
    seen.set(key, true);
    deduped.push(ch);
  }
  
  console.log(`📋 Chapters: ${chapters.length} → ${deduped.length} after dedupe`);
  return deduped;
}

function getOptimizedFilename(originalPath) {
  const dir = path.dirname(originalPath);
  const base = path.basename(originalPath, '.webp');
  return path.join(dir, `${base}ds.webp`);
}

function logError(type, context, error) {
  const entry = {
    timestamp: new Date().toISOString(),
    type,
    context,
    error: error.message || String(error),
    stack: error.stack
  };
  
  if (type === 'download') {
    logs.downloads.failed.push(entry);
    console.error(`\n❌ [DOWNLOAD] Ch${context.chapter}/Pg${context.page}`);
    console.error(`   URL: ${context.url}`);
    console.error(`   └─ ${error.message}`);
  } else if (type === 'optimize') {
    logs.optimizations.failed.push(entry);
    console.error(`\n❌ [OPTIMIZE] ${context.file}`);
    console.error(`   └─ ${error.message}`);
  }
  return entry;
}

async function optimizeWithSharp(inputPath) {
  const outputPath = getOptimizedFilename(inputPath);
  try {
    await sharp(inputPath).webp(WEBP_OPTIONS).toFile(outputPath);
    await fs.unlink(inputPath);
    logs.optimizations.success++;
    return outputPath;
  } catch (error) {
    logError('optimize', { file: path.basename(inputPath) }, error);
    if (fsSync.existsSync(outputPath)) {
      await fs.unlink(outputPath).catch(() => {});
    }
    return inputPath;
  }
}

async function getFolderSize(folderPath) {
  let total = 0;
  const walk = async (dir) => {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else {
          const stat = await fs.stat(fullPath);
          total += stat.size;
        }
      }
    } catch (e) {
      // Folder might not exist yet
    }
  };
  await walk(folderPath);
  return total;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

async function calculateTotalSize(zipFiles) {
  let total = 0;
  for (const zip of zipFiles) {
    try {
      const stat = await fs.stat(zip.path);
      total += stat.size;
    } catch (e) {
      console.warn(`⚠️  Could not stat ${zip.path}: ${e.message}`);
    }
  }
  return total;
}

// == Telegram Helpers ==
async function telegramSendPhoto(caption, photoPath, thumbPath) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return null;
  
  try {
    const formData = new FormData();
    formData.append('chat_id', TG_CHAT_ID);
    formData.append('caption', caption);
    formData.append('parse_mode', 'HTML');
    
    const photoBlob = await fs.readFile(photoPath);
    formData.append('photo', new Blob([photoBlob]), path.basename(photoPath));
    
    if (thumbPath && fsSync.existsSync(thumbPath)) {
      const thumbBlob = await fs.readFile(thumbPath);
      formData.append('thumbnail', new Blob([thumbBlob]), path.basename(thumbPath));
    }
    
    const response = await fetch(`${TG_API}${TG_BOT_TOKEN}/sendPhoto`, {
      method: 'POST',
      body: formData
    });
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'No error body');
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }
    
    const result = await response.json();
    logs.telegram.success++;
    return result.ok ? result.result.message_id : null;
    
  } catch (error) {
    logs.telegram.failed.push({
      timestamp: new Date().toISOString(),
      action: 'sendPhoto',
      photo: path.basename(photoPath),
      error: error.message
    });
    console.error(`❌ [TELEGRAM] Failed to send photo: ${error.message}`);
    return null;
  }
}

async function telegramSendDocument(filePath, caption, replyToMessageId, thumbPath) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;
  
  try {
    const formData = new FormData();
    formData.append('chat_id', TG_CHAT_ID);
    formData.append('document', new Blob([await fs.readFile(filePath)]), path.basename(filePath));
    formData.append('caption', caption);
    formData.append('parse_mode', 'HTML');
    
    if (replyToMessageId) {
      formData.append('reply_to_message_id', replyToMessageId);
    }
    
    if (thumbPath && fsSync.existsSync(thumbPath)) {
      formData.append('thumbnail', new Blob([await fs.readFile(thumbPath)]), path.basename(thumbPath));
    }
    
    const response = await fetch(`${TG_API}${TG_BOT_TOKEN}/sendDocument`, {
      method: 'POST',
      body: formData
    });
    
    if (!response.ok) {
      const errorText = await response.text().catch(() => 'No error body');
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }
    
    logs.telegram.success++;
    await new Promise(resolve => setTimeout(resolve, TG_DELAY_MS));
    
  } catch (error) {
    logs.telegram.failed.push({
      timestamp: new Date().toISOString(),
      action: 'sendDocument',
      file: path.basename(filePath),
      error: error.message
    });
    console.error(`❌ [TELEGRAM] Failed to send document ${path.basename(filePath)}: ${error.message}`);
  }
}

async function sendMangaInfo(manga, coverPath, displayTitle) {
  if (!TG_BOT_TOKEN || !TG_CHAT_ID) {
    console.log('⚠️  Telegram not configured (missing TG_BOT_TOKEN or TG_CHAT_ID)');
    return null;
  }
  
  // ✅ FIXED: Safe formatList with escapeHtml + toArray
  const formatList = (arr, label) => {
    if (!arr || !Array.isArray(arr) || arr.length === 0) return '';
    const safeItems = arr.map(item => escapeHtml(item));
    return `\n${label}: ${safeItems.join(', ')}`;
  };
  
  const titleHtml = escapeHtml(displayTitle);
  const descRaw = manga.description || '';
  const description = escapeHtml(descRaw.substring(0, 800)) + (descRaw.length > 800 ? '...' : '');
  
  const caption = `<b>${titleHtml}</b>\n` +
    `${description}\n` +
    `🏷️ <b>Type:</b> ${escapeHtml(manga.type || 'N/A')}\n` +
    `🌐 <b>Language:</b> ${escapeHtml(manga.language || 'N/A')}\n` +
    `📊 <b>Status:</b> ${escapeHtml(manga.status || 'N/A')}\n` +
    `📅 <b>Year:</b> ${escapeHtml(manga.year || 'N/A')}\n` +
    `🔢 <b>Latest Chapter:</b> ${escapeHtml(manga.latest_chapter || 'N/A')}` +
    formatList(toArray(manga.genres), '🎭 <b>Genres</b>') +
    formatList(toArray(manga.authors), '✍️ <b>Authors</b>') +
    formatList(toArray(manga.artists), '🎨 <b>Artists</b>');
  
  console.log('📤 Sending manga info to Telegram...');
  const messageId = await telegramSendPhoto(caption, coverPath, coverPath);
  
  if (messageId) {
    console.log(`✅ Manga info sent (message_id: ${messageId})`);
  }
  return messageId;
}

async function createZipGroups(baseDir, chapters, safeTitle, displayTitle) {
  const groups = [];
  let currentGroup = [];
  let currentSize = 0;
  
  const chapterSizes = [];
  for (const chapter of chapters) {
    const chapterPadded = String(chapter.number).padStart(3, '0');
    const safeChapterName = sanitize(chapter.name || '');
    const chapterDir = safeChapterName
      ? path.join(baseDir, `Chapter_${chapterPadded}_${safeChapterName}`)
      : path.join(baseDir, `Chapter_${chapterPadded}`);
    
    const size = await getFolderSize(chapterDir);
    chapterSizes.push({ chapter, dir: chapterDir, size });
  }
  
  for (const item of chapterSizes) {
    const estimatedZipSize = item.size * 1.1;
    
    if (currentSize + estimatedZipSize > TARGET_ZIP_SIZE_BYTES && currentGroup.length > 0) {
      groups.push(currentGroup);
      currentGroup = [item];
      currentSize = item.size;
    } else {
      currentGroup.push(item);
      currentSize += item.size;
    }
  }
  
  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }
  
  const zipFiles = [];
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const minChapter = group[0].chapter.number;
    const maxChapter = group[group.length - 1].chapter.number;
    
    const chapterRange = minChapter === maxChapter 
      ? `ch${minChapter}` 
      : `ch${minChapter}-${maxChapter}`;
    
    const zipName = `${safeTitle}_${chapterRange}_ds.zip`;
    
    console.log(`🗜️  Creating zip ${i + 1}/${groups.length}: ${zipName}`);
    
    const filesToZip = group.map(g => `"${path.relative(baseDir, g.dir)}"`).join(' ');
    execSync(`cd "${baseDir}" && zip -rq "../${zipName}" ${filesToZip}`, { stdio: 'pipe' });
    
    const zipPath = path.join(__dirname, zipName);
    const zipSize = fsSync.statSync(zipPath).size;
    console.log(`   📦 ${zipName}: ${formatBytes(zipSize)}`);
    
    zipFiles.push({ 
      path: zipPath, 
      name: zipName, 
      minChapter, 
      maxChapter,
      displayTitle 
    });
  }
  
  return zipFiles;
}

async function downloadImage(imageUrl, outputFile) {
  const curlCmd = `curl -sL \
    -H "Referer: https://comix.to/" \
    -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" \
    --compressed \
    --keepalive-time 10 \
    "${imageUrl}" \
    -o "${outputFile}" \
    --retry 2 \
    --connect-timeout 20 \
    --speed-time 30 \
    --speed-limit 1000`;
  
  execSync(curlCmd, { stdio: 'ignore' });
}

async function processChapter(chapter, baseDir, displayTitle) {
  const chapterNum = chapter.number;
  const chapterName = chapter.name || '';
  const chapterPadded = String(chapterNum).padStart(3, '0');
  const safeChapterName = sanitize(chapterName);
  
  const chapterDir = safeChapterName
    ? path.join(baseDir, `Chapter_${chapterPadded}_${safeChapterName}`)
    : path.join(baseDir, `Chapter_${chapterPadded}`);
  
  if (!fsSync.existsSync(chapterDir)) {
    await fs.mkdir(chapterDir, { recursive: true });
  }
  
  console.log(`⬇️  [${displayTitle}] Chapter ${chapterNum}: ${chapterDir} (${chapter.pages_count} pages)`);
  
  const downloadLimit = pLimit(DOWNLOAD_CONCURRENCY);
  const filesToOptimize = [];
  
  const downloadTasks = chapter.images.map((imageUrl, pageIndex) => {
    return downloadLimit(async () => {
      const pagePadded = String(pageIndex + 1).padStart(3, '0');
      const outputFile = path.join(chapterDir, `${pagePadded}.webp`);
      
      const finalFile = OPTIMIZE ? getOptimizedFilename(outputFile) : outputFile;
      if (fsSync.existsSync(finalFile)) {
        process.stdout.write('↻');
        return { skipped: true, file: finalFile };
      }
      
      try {
        await downloadImage(imageUrl.trim(), outputFile);
        process.stdout.write('.');
        logs.downloads.success++;
        
        if (OPTIMIZE) {
          filesToOptimize.push(outputFile);
        }
        return { success: true, file: outputFile };
      } catch (error) {
        logError('download', {
          chapter: chapterNum,
          page: pagePadded,
          url: imageUrl.trim()
        }, error);
        
        if (fsSync.existsSync(outputFile)) {
          await fs.unlink(outputFile).catch(() => {});
        }
        return { success: false, error: error.message };
      }
    });
  });
  
  await Promise.all(downloadTasks);
  
  if (OPTIMIZE && filesToOptimize.length > 0) {
    console.log(`\n🎨 Optimizing ${filesToOptimize.length} images (parallel)...`);
    const optimizeLimit = pLimit(OPTIMIZE_CONCURRENCY);
    
    const optimizeTasks = filesToOptimize.map(filePath => {
      return optimizeLimit(async () => {
        try {
          await optimizeWithSharp(filePath);
          process.stdout.write('✨');
          return true;
        } catch (error) {
          return false;
        }
      });
    });
    
    await Promise.all(optimizeTasks);
    console.log('');
  }
  
  console.log(' ✅ Chapter done');
  logs.chapters.success++;
  return { success: true, chapter: chapterNum };
}

function printSummary(startTime, zipFiles = [], mangaId = 'N/A', latestCh = 'N/A', displayTitle = 'N/A') {
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  
  console.log('\n' + '═'.repeat(60));
  console.log('📊 DOWNLOAD & OPTIMIZATION SUMMARY');
  console.log('═'.repeat(60));
  
  const totalDownloads = logs.downloads.success + logs.downloads.failed.length;
  console.log(`📥 Downloads: ${logs.downloads.success}/${totalDownloads} succeeded`);
  if (logs.downloads.failed.length > 0) {
    console.log(`   ❌ Failed: ${logs.downloads.failed.length}`);
    logs.downloads.failed.slice(0, 5).forEach(f => {
      const err = f.error.length > 60 ? f.error.substring(0, 60) + '...' : f.error;
      console.log(`      • Ch${f.context.chapter}/Pg${f.context.page}: ${err}`);
    });
    if (logs.downloads.failed.length > 5) {
      console.log(`      ...and ${logs.downloads.failed.length - 5} more`);
    }
  }
  
  if (OPTIMIZE) {
    const totalOpt = logs.optimizations.success + logs.optimizations.failed.length;
    console.log(`🎨 Optimizations: ${logs.optimizations.success}/${totalOpt} succeeded`);
    if (logs.optimizations.failed.length > 0) {
      console.log(`   ❌ Failed: ${logs.optimizations.failed.length}`);
      logs.optimizations.failed.slice(0, 5).forEach(f => {
        const err = f.error.length > 60 ? f.error.substring(0, 60) + '...' : f.error;
        console.log(`      • ${f.context.file}: ${err}`);
      });
      if (logs.optimizations.failed.length > 5) {
        console.log(`      ...and ${logs.optimizations.failed.length - 5} more`);
      }
    }
  }
  
  const tgTotal = logs.telegram.success + logs.telegram.failed.length;
  if (tgTotal > 0) {
    console.log(`📤 Telegram: ${logs.telegram.success}/${tgTotal} sent`);
    if (logs.telegram.failed.length > 0) {
      logs.telegram.failed.slice(0, 5).forEach(f => {
        console.log(`   ❌ ${f.action}(${f.file || f.photo}): ${f.error}`);
      });
      if (logs.telegram.failed.length > 5) {
        console.log(`   ...and ${logs.telegram.failed.length - 5} more`);
      }
    }
  }
  
  if (zipFiles.length > 0) {
    const totalZipSize = zipFiles.reduce((sum, z) => {
      try { return sum + fsSync.statSync(z.path).size; } catch { return sum; }
    }, 0);
    console.log(`📦 Total output size: ${formatBytes(totalZipSize)}`);
  }
  
  console.log(`⏱️  Total time: ${duration}s`);
  console.log('═'.repeat(60));
  console.log(`🔗 Manga: ${displayTitle} • Ch.${latestCh}`);

  if (process.env.GITHUB_STEP_SUMMARY) {
    let summary = `## 📊 Summary\n`;
    summary += `- ⏱️ Duration: ${duration}s\n`;
    summary += `- 📥 Downloads: ${logs.downloads.success}/${totalDownloads}\n`;
    if (OPTIMIZE) {
      summary += `- 🎨 Optimizations: ${logs.optimizations.success}/${logs.optimizations.success + logs.optimizations.failed.length}\n`;
    }
    
    if (tgTotal > 0) {
      summary += `- 📤 Telegram: ${logs.telegram.success}/${tgTotal} sent\n`;
    }
    
    summary += `- 🔗 Manga: \`${escapeHtml(displayTitle)}\` • Ch.\`${latestCh}\`\n`;
    
    if (zipFiles.length > 0) {
      const totalZipSize = zipFiles.reduce((sum, z) => {
        try { return sum + fsSync.statSync(z.path).size; } catch { return sum; }
      }, 0);
      summary += `- 📦 Total output: ${formatBytes(totalZipSize)}\n`;
    }
    
    const totalErrors = logs.downloads.failed.length + logs.optimizations.failed.length + logs.telegram.failed.length;
    if (totalErrors > 0) {
      summary += `- ⚠️ Errors: ${totalErrors}\n`;
    }
    
    if (logs.downloads.failed.length > 0 || logs.telegram.failed.length > 0) {
      summary += `\n<details><summary>🔍 View errors</summary>\n\n`;
      if (logs.downloads.failed.length > 0) {
        summary += `**Failed Downloads**:\n`;
        logs.downloads.failed.slice(0, 5).forEach(f => {
          summary += `- Ch${f.context.chapter}/Pg${f.context.page}: ${f.error}\n`;
        });
      }
      if (logs.telegram.failed.length > 0) {
        summary += `\n**Telegram Failures**:\n`;
        logs.telegram.failed.slice(0, 5).forEach(f => {
          summary += `- ${f.action}: ${f.error}\n`;
        });
      }
      summary += `\n</details>`;
    }
    
    fsSync.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
}

async function run() {
  const startTime = Date.now();
  console.log(`🚀 Started at ${new Date().toISOString()}`);
  
  const data = JSON.parse(await fs.readFile(JSON_FILE, 'utf8'));
  const manga = data.manga;
    const chapters = dedupeChapters(data.chapters);
  
  const displayTitle = manga.title || 'Unknown';
  const safeTitle = sanitize(displayTitle);
  
  console.log(`📚 Downloading: ${displayTitle}`);
  
  let coverPath = null;
  if (manga.cover && TG_BOT_TOKEN) {
    coverPath = path.join(__dirname, `${safeTitle}_cover.jpg`);
    const curlCmd = `curl -sL -o "${coverPath}" "${manga.cover}" --retry 3 --connect-timeout 30`;
    try {
      execSync(curlCmd, { stdio: 'pipe' });
      console.log('🖼️  Cover downloaded for Telegram thumbnail');
    } catch (e) {
      console.warn('⚠️  Failed to download cover:', e.message);
      coverPath = null;
    }
  }
  
  const baseDir = safeTitle;
  if (!fsSync.existsSync(baseDir)) {
    await fs.mkdir(baseDir, { recursive: true });
  }
  
  const chapterLimit = pLimit(2);
  const chapterTasks = chapters.map(ch => 
    chapterLimit(() => processChapter(ch, baseDir, displayTitle))
  );
  
  await Promise.all(chapterTasks);
  
  console.log('\n📦 Calculating zip groups...');
  const zipFiles = await createZipGroups(baseDir, chapters, safeTitle, displayTitle);
  
  let infoMessageId = null;
  if (TG_BOT_TOKEN && TG_CHAT_ID) {
    infoMessageId = await sendMangaInfo(manga, coverPath, displayTitle);
    
    const totalSize = await calculateTotalSize(zipFiles);
    
    for (let i = 0; i < zipFiles.length; i++) {
      const zip = zipFiles[i];
      const current = i + 1;
      const total = zipFiles.length;
      
      const chapterRange = zip.minChapter === zip.maxChapter 
        ? `${zip.minChapter}` 
        : `${zip.minChapter}-${zip.maxChapter}`;
      
      const caption = `📦 <b>${escapeHtml(zip.displayTitle)}</b>\n` +
        `Chapters ${chapterRange}\n` +
        `🎨 WebP ${OPTIMIZE ? '(optimized, ds)' : ''}, ${current}/${total}\n` +
        `📊 Total: ${formatBytes(totalSize)} | This: ${formatBytes(fsSync.statSync(zip.path).size)}`;
      
      console.log(`📤 Sending ${zip.name} to Telegram...`);
      await telegramSendDocument(zip.path, caption, infoMessageId, coverPath);
      console.log(`✅ Sent: ${zip.name}`);
    }
    
    console.log('✨ All files sent to Telegram!');
  } else {
    console.log('\n⚠️  Telegram not configured. Zips created locally:');
    zipFiles.forEach(z => console.log(`   - ${z.name}`));
  }
  
 const mangaId = extractMangaId(manga.url);
  const latestCh = manga.latest_chapter ?? manga.latestChapter ?? 'N/A';
  printSummary(startTime, zipFiles, mangaId, latestCh, displayTitle);

  // 🔴 Exit with error if any failures occurred (for GitHub Actions)
  if (hasFailures()) {
    console.error('\n❌ Workflow failed due to errors above.');
    process.exit(1);
  }
}

run().catch(error => {
  console.error('💥 Fatal error:', error);
  printSummary(Date.now(), [], 'N/A', 'N/A', 'Unknown');
  process.exit(1); 
});
