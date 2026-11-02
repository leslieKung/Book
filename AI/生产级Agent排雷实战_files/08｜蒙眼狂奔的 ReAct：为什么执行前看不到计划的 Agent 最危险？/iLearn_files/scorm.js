var SCORM = (function () {
  let API = null;
  let initialized = false;
  let courseSku = "";
  let totalLearnSeconds = 0;
  let sessionLearnSeconds = 0;
  let lessonProgressStorage = "unknown";
  let lessonStatus = "not attempted";
  let tickRemainderMs = 0;
  let sessionStarted = false;
  let flushHandlersBound = false;
  let ready = false;
  let writeEnabled = false;
  let storageStatus = "unavailable";
  let suspendRoot = {};
  let sections = {};
  let videoMilliseconds = {};
  let audioMilliseconds = {};
  let mediaDurations = {};
  let readingDurations = {};
  let positions = new Map();
  let completed = false;
  let last = null;
  let catalogIds = null;
  let optionalCatalogIds = new Set();
  let onStateChange = null;
  let heartbeatId = null;
  const readingAcknowledged = new Map();
  const videoAcknowledged = new Map();
  const audioAcknowledged = new Map();
  const realAcknowledged = new Map();

  function findAPI(win) {
    let attempts = 0;
    while (win) {
      try {
        if (win.API) return win.API;
        if (win.parent === win) break;
        win = win.parent;
      } catch (error) {
        break; // 跨域祖先不可访问时，仍尝试 opener。
      }
      attempts++;
      if (attempts > 500) break;
    }
    return null;
  }

  function getAPI() {
    let api = findAPI(window);
    if (!api && window.opener) {
      api = findAPI(window.opener);
    }
    return api;
  }

  function getValue(k) {
    if (!initialized) return "";
    return API.LMSGetValue(k);
  }

  function isScormSuccessResult(value) {
    if (value === true || value === "true") return true;
    if (typeof value === "string") return value.trim().toLowerCase() === "true";
    return false;
  }

  function normalizeScormErrorCode(value) {
    if (value === null || value === undefined) return "";
    return String(value).trim();
  }

  function isScormNoError(value) {
    const normalized = normalizeScormErrorCode(value);
    return normalized === "" || normalized === "0";
  }

  function safeSetValue(k, v) {
    if (!initialized || !writeEnabled) return false;
    try {
      const result = API.LMSSetValue(k, v);
      if (isScormSuccessResult(result) && isScormNoError(getLastErrorCode())) return true;
    } catch (error) {
      logError("setValue exception", { sku: courseSku, key: k, length: String(v).length });
      return false;
    }
    logError("setValue failed", { sku: courseSku, key: k, length: String(v).length, errorCode: getLastErrorCode() });
    return false;
  }

  function getLastErrorCode() {
    try {
      if (typeof API.LMSGetLastError === "function") return API.LMSGetLastError();
    } catch (e) {}
    return "";
  }

  function getErrorString(errorCode) {
    try {
      if (typeof API.LMSGetErrorString === "function") return API.LMSGetErrorString(errorCode);
    } catch (e) {}
    return "";
  }

  function getDiagnostic(errorCode) {
    try {
      if (typeof API.LMSGetDiagnostic === "function") return API.LMSGetDiagnostic(errorCode);
    } catch (e) {}
    return "";
  }

  function getValueResult(k) {
    if (!initialized) return { value: "", supported: false, errorCode: "not_initialized" };
    try {
      const value = API.LMSGetValue(k);
      const errorCode = getLastErrorCode();
      const supported = isScormNoError(errorCode);
      return { value: value ?? "", supported, errorCode };
    } catch (e) {
      return { value: "", supported: false, errorCode: "exception" };
    }
  }

  function commitToLms(context) {
    if (!initialized || !writeEnabled) return false;
    try {
      const result = API.LMSCommit("");
      if (isScormSuccessResult(result) && isScormNoError(getLastErrorCode())) return true;
    } catch (error) {
      logError("LMSCommit exception", { sku: courseSku, context });
      return false;
    }
    logError("LMSCommit failed", { sku: courseSku, context, errorCode: getLastErrorCode() });
    return false;
  }

  function finishToLms(context) {
    try {
      if (isScormSuccessResult(API.LMSFinish(""))) return true;
    } catch (error) {
      logError("LMSFinish exception", { sku: courseSku, context });
      return false;
    }
    logError("LMSFinish failed", { sku: courseSku, context, errorCode: getLastErrorCode() });
    return false;
  }

  function logInfo(event, details) {
    if (details === undefined) {
      console.log(`[SCORM] ${event}`);
      return;
    }
    console.log(`[SCORM] ${event}`, details);
  }

  function logError(event, details) {
    if (details === undefined) {
      console.error(`[SCORM] ${event}`);
      return;
    }
    console.error(`[SCORM] ${event}`, details);
  }

  function parseSuspendDataObject(suspendData) {
    if (!suspendData || typeof suspendData !== "string") return null;
    try {
      const parsed = JSON.parse(suspendData);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch (e) {}
    return null;
  }

  function formatSecondsToSessionTime(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(s / 3600);
    const minutes = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    const hh = String(Math.min(hours, 9999)).padStart(4, "0");
    const mm = String(minutes).padStart(2, "0");
    const ss = String(secs).padStart(2, "0");
    return `${hh}:${mm}:${ss}.00`;
  }

  function formatSecondsToSessionTimeLegacy(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    const hours = Math.min(Math.floor(s / 3600), 99);
    const minutes = Math.floor((s % 3600) / 60);
    const secs = s % 60;
    const hh = String(hours).padStart(2, "0");
    const mm = String(minutes).padStart(2, "0");
    const ss = String(secs).padStart(2, "0");
    return `${hh}:${mm}:${ss}`;
  }

  function normalizeId(value) {
    const id = String(value ?? "");
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id))) return null;
    return id;
  }

  function restoreSections(scope) {
    if (![2, 3, 4, 5, 6, 7].includes(scope.v) ||
        typeof scope.sections !== "string" || typeof scope.completed !== "boolean") return false;
    if (scope.totalLearnSeconds !== undefined && (!Number.isSafeInteger(scope.totalLearnSeconds) || scope.totalLearnSeconds < 0)) return false;
    const restored = {};
    if (scope.sections) {
      if (!scope.sections.endsWith(";")) return false;
      for (const record of scope.sections.slice(0, -1).split(";")) {
        if (!/^[0-9a-z]+:[0-9a-z]+$/.test(record)) return false;
        const [encodedId, encodedState] = record.split(":");
        const id = normalizeId(Number.parseInt(encodedId, 36));
        const state = Number.parseInt(encodedState, 36);
        if (!id || Number(id).toString(36) !== encodedId || !Number.isSafeInteger(state) || state < 1 || scope.v < 6 && state > 181 ||
            state.toString(36) !== encodedState || Object.prototype.hasOwnProperty.call(restored, id)) return false;
        restored[id] = state;
      }
    }
    const restoredReadingDurations = {};
    if (scope.readingDurations !== undefined) {
      if (scope.v < 6 || typeof scope.readingDurations !== "string" ||
          scope.readingDurations && !scope.readingDurations.endsWith(";")) return false;
      for (const record of scope.readingDurations ? scope.readingDurations.slice(0, -1).split(";") : []) {
        if (!/^[0-9a-z]+:[0-9a-z]+$/.test(record)) return false;
        const [encodedId, encodedDuration] = record.split(":");
        const id = normalizeId(Number.parseInt(encodedId, 36));
        const duration = Number.parseInt(encodedDuration, 36);
        if (!id || Number(id).toString(36) !== encodedId || !Number.isSafeInteger(duration) || duration <= 0 ||
            duration.toString(36) !== encodedDuration || Object.prototype.hasOwnProperty.call(restoredReadingDurations, id)) return false;
        restoredReadingDurations[id] = duration;
      }
    }
    for (const [id, state] of Object.entries(restored)) {
      if (state > 181 && !restoredReadingDurations[id]) return false;
    }
    const restoredVideo = {};
    const restoredAudio = {};
    const restoredDurations = {};
    for (const [field, target] of [["videoMilliseconds", restoredVideo], ["audioMilliseconds", restoredAudio]]) {
      if (scope[field] === undefined || scope[field] === "") continue;
      if (typeof scope[field] !== "string" || !scope[field].endsWith(";")) return false;
      for (const record of scope[field].slice(0, -1).split(";")) {
        if (!(scope.v >= 5 ? /^[0-9a-z]+:[0-9a-z]+(,[0-9a-z]+)?$/ : /^[0-9a-z]+:[0-9a-z]+$/).test(record)) return false;
        const [encodedId, encodedValues] = record.split(":");
        const [encodedTime, encodedDuration] = encodedValues.split(",");
        const id = normalizeId(Number.parseInt(encodedId, 36));
        const milliseconds = Number.parseInt(encodedTime, 36);
        if (!id || Number(id).toString(36) !== encodedId || !Number.isSafeInteger(milliseconds) || milliseconds < 0 ||
            milliseconds.toString(36) !== encodedTime || Object.prototype.hasOwnProperty.call(target, id)) return false;
        target[id] = milliseconds;
        if (encodedDuration !== undefined) {
          const duration = Number.parseInt(encodedDuration, 36);
          if (!Number.isSafeInteger(duration) || duration <= 0 || duration.toString(36) !== encodedDuration) return false;
          restoredDurations[id] = duration / 1000;
        }
      }
    }
    const restoredPositions = new Map();
    let restoredLast = null;
    if (scope.positions !== undefined) {
      if (typeof scope.positions !== "string" || scope.positions && !scope.positions.endsWith(";")) return false;
      for (const record of scope.positions ? scope.positions.slice(0, -1).split(";") : []) {
        if (!/^[0-9a-z]+:[va][0-9a-z]+(,[0-9a-z]+)?$/.test(record)) return false;
        const [encodedId, encodedPosition] = record.split(":");
        const id = normalizeId(Number.parseInt(encodedId, 36));
        const kind = encodedPosition[0] === "v" ? "video" : "article";
        const [pagePosition, audioPosition] = encodedPosition.slice(1).split(",");
        const position = Number.parseInt(pagePosition, 36);
        if (!id || Number(id).toString(36) !== encodedId || restoredPositions.has(id) ||
            !Number.isSafeInteger(position) || position < 0 || position.toString(36) !== pagePosition ||
            kind === "article" && position > 10000) return false;
        const bookmark = { kind, position };
        if (audioPosition !== undefined) {
          const seconds = Number.parseInt(audioPosition, 36);
          if (scope.v < 4 || kind !== "article" || !Number.isSafeInteger(seconds) || seconds < 0 ||
              seconds.toString(36) !== audioPosition) return false;
          bookmark.audioPosition = seconds;
        }
        restoredPositions.set(id, bookmark);
        restoredLast = { id, kind, position };
      }
    } else if (scope.last !== null && scope.last !== undefined) {
      // 旧存档只有一个 last；升级后也参与最近访问顺序和容量淘汰。
      if (!normalizeId(scope.last.id) || !["video", "article"].includes(scope.last.kind) ||
          !Number.isSafeInteger(scope.last.position) || scope.last.position < 0) return false;
      const position = scope.last.kind === "article" ? Math.min(10000, scope.last.position) : scope.last.position;
      restoredLast = { id: String(scope.last.id), kind: scope.last.kind, position };
      restoredPositions.set(restoredLast.id, { kind: restoredLast.kind, position });
    }
    positions = restoredPositions;
    last = restoredLast;
    sections = restored;
    videoMilliseconds = restoredVideo;
    audioMilliseconds = restoredAudio;
    // v2-v4 没有倍速明细，未完成记录按原时长作为 1 倍速学习量迁移，已完成状态保持。
    mediaDurations = restoredDurations;
    readingDurations = restoredReadingDurations;
    // v7 起音频与阅读并行；旧音频记录中的阅读秒数不是独立学习量。
    if (scope.v < 7) {
      for (const id of Object.keys(audioMilliseconds)) if (sections[id] >= 3) sections[id] = 1;
    }
    completed = scope.completed;
    return true;
  }

  function getState(clientId) {
    return {
      v: 2, courseID: courseSku, ready, storageStatus, historyReady: writeEnabled, contentProgress: true,
      mediaDurations: { ...mediaDurations },
      readingDurations: { ...readingDurations },
      readingAcknowledged: { ...readingAcknowledged.get(clientId) },
      videoAcknowledged: { ...videoAcknowledged.get(clientId) }, videoMilliseconds: { ...videoMilliseconds },
      audioAcknowledged: { ...audioAcknowledged.get(clientId) }, audioMilliseconds: { ...audioMilliseconds },
      completed, sections: { ...sections }, last: last ? { ...last } : null,
      positions: Object.fromEntries([...positions].map(([id, bookmark]) => [id, { ...bookmark }])),
      progress: completed ? 100 : 0,
    };
  }

  function setCatalog(ids, optionalIds = []) {
    if (!ready) return false;
    const invalidCount = Array.isArray(ids) ? ids.filter(id => !normalizeId(id)).length : null;
    if (invalidCount === null || invalidCount > 0) {
      logError("catalog rejected", { sku: courseSku, stage: "setCatalog",
        invalidCount });
      return false;
    }
    const nextIds = [...new Set(ids.map(String))];
    const invalidOptionalCount = Array.isArray(optionalIds)
      ? optionalIds.filter(id => !nextIds.includes(String(id))).length : null;
    if (invalidOptionalCount === null || invalidOptionalCount > 0) {
      logError("catalog rejected", { sku: courseSku, stage: "setCatalog", invalidOptionalCount });
      return false;
    }
    catalogIds = nextIds;
    optionalCatalogIds = new Set(optionalIds.map(String));
    // 空目录可能是尚未加载完成，不能清理存档或因 every([]) 提前完成。
    if (catalogIds.length) {
      const current = new Set(catalogIds);
      for (const id of Object.keys(sections)) if (!current.has(id)) delete sections[id];
      for (const id of Object.keys(videoMilliseconds)) if (!current.has(id)) delete videoMilliseconds[id];
      for (const id of Object.keys(audioMilliseconds)) if (!current.has(id)) delete audioMilliseconds[id];
      for (const id of Object.keys(mediaDurations)) if (!current.has(id)) delete mediaDurations[id];
      for (const id of Object.keys(readingDurations)) if (!current.has(id)) delete readingDurations[id];
      for (const id of positions.keys()) if (!current.has(id)) positions.delete(id);
      if (last && !current.has(last.id)) last = null;
      const newlyCompleted = updateCompletionState();
      commit();
      if (newlyCompleted && onStateChange) onStateChange(getState());
    }
    return true;
  }

  function updateSection(update) {
    const id = normalizeId(update?.articleID);
    if (!ready || !id || !catalogIds?.includes(id) || !["article", "video"].includes(update.kind)) return false;
    let previous = sections[id] || 0;
    const audio = update.kind === "article" && (update.hasAudio === true ||
      update.hasAudio !== false && Object.prototype.hasOwnProperty.call(audioMilliseconds, id));
    const video = update.kind === "video";
    const media = video || audio;
    if (update.hasAudio === false) delete audioMilliseconds[id];
    if (!video && Number.isSafeInteger(update.readingDuration) && update.readingDuration > 0) {
      readingDurations[id] = update.readingDuration;
    } else if (video || update.readingDuration === 0) {
      if (readingDurations[id] && previous !== 2) {
        previous = sections[id] = 1;
        const acknowledged = readingAcknowledged.get(update.clientId);
        if (acknowledged) delete acknowledged[id];
      }
      // 0 仅作为本次会话的兜底选择，迟到历史不能重新启用已失效的建议时长。
      readingDurations[id] = 0;
    }
    const readingDuration = !video && readingDurations[id] || 0;
    const readingTarget = readingDuration ? Math.ceil(readingDuration * 0.98) : 180;
    let seconds = update.seconds;
    if (!video && typeof update.clientId === "string" &&
        Number.isSafeInteger(update.elapsedSeconds) && update.elapsedSeconds >= 0) {
      const acknowledged = readingAcknowledged.get(update.clientId) || {};
      const elapsed = Math.min(readingDuration || 180, update.elapsedSeconds);
      seconds = (previous >= 3 ? previous - 2 : 0) + Math.max(0, elapsed - (acknowledged[id] || 0));
      acknowledged[id] = Math.max(acknowledged[id] || 0, elapsed);
      readingAcknowledged.set(update.clientId, acknowledged);
    }
    const totals = audio ? audioMilliseconds : videoMilliseconds;
    if (media) {
      const elapsed = audio ? update.audioElapsedMilliseconds : update.videoElapsedMilliseconds;
      const watched = audio ? update.audioMilliseconds : update.watchedMilliseconds;
      const confirmations = audio ? audioAcknowledged : videoAcknowledged;
      // 未完成音频保留零值标记，与阅读秒数分别续计。
      totals[id] = totals[id] || 0;
      if (typeof update.clientId === "string" && Number.isSafeInteger(elapsed) && elapsed >= 0) {
        const acknowledged = confirmations.get(update.clientId) || {};
        totals[id] += Math.max(0, elapsed - (acknowledged[id] || 0));
        acknowledged[id] = Math.max(acknowledged[id] || 0, elapsed);
        confirmations.set(update.clientId, acknowledged);
      } else if (Number.isSafeInteger(watched) && watched >= 0) {
        totals[id] = Math.max(totals[id], watched);
      }
    }
    // 新课件按前端累计的真实播放/阅读增量上报 LMS，重复消息不重复计时，完成后仍可累计。
    if (typeof update.clientId === "string" &&
        Number.isSafeInteger(update.realElapsedMilliseconds) && update.realElapsedMilliseconds >= 0) {
      const acknowledged = realAcknowledged.get(update.clientId) || {};
      tickRemainderMs += Math.max(0, update.realElapsedMilliseconds - (acknowledged[id] || 0));
      acknowledged[id] = Math.max(acknowledged[id] || 0, update.realElapsedMilliseconds);
      realAcknowledged.set(update.clientId, acknowledged);
      const seconds = Math.floor(tickRemainderMs / 1000);
      tickRemainderMs -= seconds * 1000;
      totalLearnSeconds += seconds;
      sessionLearnSeconds += seconds;
    }
    let duration = audio ? update.audioDuration : update.duration;
    if (media && Number.isFinite(duration) && duration > 0 &&
        Number.isSafeInteger(Math.round(duration * 1000))) mediaDurations[id] = duration;
    if (!media) delete mediaDurations[id];
    if (media) duration = mediaDurations[id];
    // 两路独立达标；音频仍需本次结束，通用 completed 不能冒充音频图文的阅读完成。
    const mediaFinished = media && (audio ? update.audioCompleted === true : update.completed === true) &&
      Number.isFinite(duration) && duration > 0 && totals[id] >= Math.max(1, Math.round(duration * 980));
    const readingFinished = !video && (readingDuration
      ? Number.isSafeInteger(seconds) && seconds >= readingTarget
      : update.readingCompleted === true || !audio && update.completed === true ||
        Number.isSafeInteger(seconds) && seconds >= readingTarget);
    const state = mediaFinished || readingFinished ? 2 : !video &&
      Number.isSafeInteger(seconds) && seconds >= 1 ? seconds + 2 : 1;
    const switched = last?.id !== id;
    if (previous !== 2) sections[id] = state === 2 ? 2 : Math.max(previous, state);
    const validPosition = Number.isSafeInteger(update.position) && update.position >= 0;
    const validAudioPosition = audio && Number.isSafeInteger(update.audioPosition) && update.audioPosition >= 0;
    if (validPosition || validAudioPosition) {
      const previousBookmark = positions.get(id);
      const bookmark = previousBookmark?.kind === update.kind ? { ...previousBookmark } : { kind: update.kind, position: 0 };
      if (validPosition) bookmark.position = update.kind === "article" ? Math.min(10000, update.position) : update.position;
      if (validAudioPosition) bookmark.audioPosition = update.audioPosition;
      if (update.hasAudio === false) delete bookmark.audioPosition;
      // Map 的插入顺序就是访问顺序，不能用数字 ID 对象的枚举顺序代替。
      positions.delete(id);
      positions.set(id, bookmark);
      last = { id, kind: update.kind, position: bookmark.position };
    }
    updateCompletionState();
    if (switched || state === 2 && previous !== 2 || update.flush === true) commit();
    if (onStateChange) onStateChange(getState());
    return true;
  }

  function flushSuspendData() {
    const existingScope = suspendRoot.geekbangPlayer && String(suspendRoot.geekbangPlayer.sku) === courseSku
      ? suspendRoot.geekbangPlayer : {};
    const scope = {
      ...existingScope, v: 7, sku: courseSku, completed,
      sections: Object.entries(sections)
        .map(([id, state]) => `${Number(id).toString(36)}:${state.toString(36)};`).join(""),
      // 已完成小节无需再用时长判定，避免重看累计值占用有限的 LMS 存档空间。
      videoMilliseconds: Object.entries(videoMilliseconds).filter(([id, milliseconds]) => sections[id] !== 2 && milliseconds > 0)
        .map(([id, milliseconds]) => `${Number(id).toString(36)}:${milliseconds.toString(36)}` +
          `${mediaDurations[id] ? "," + Math.max(1, Math.round(mediaDurations[id] * 1000)).toString(36) : ""};`).join(""),
      audioMilliseconds: Object.entries(audioMilliseconds).filter(([id]) => sections[id] !== 2)
        .map(([id, milliseconds]) => `${Number(id).toString(36)}:${milliseconds.toString(36)}` +
          `${mediaDurations[id] ? "," + Math.max(1, Math.round(mediaDurations[id] * 1000)).toString(36) : ""};`).join(""),
      readingDurations: Object.entries(readingDurations).filter(([id, duration]) => duration > 0 && sections[id] !== 2)
        .map(([id, duration]) => `${Number(id).toString(36)}:${duration.toString(36)};`).join(""),
      totalLearnSeconds, lessonLocation: completed ? 100 : 0,
    };
    delete scope.baseLineDurationSeconds;
    // 位置全部可舍弃，连旧 last 和字段本身的开销也不能挤占完成状态与时长。
    delete scope.last;
    delete scope.positions;
    if (!scope.audioMilliseconds) delete scope.audioMilliseconds;
    if (!scope.readingDurations) delete scope.readingDurations;
    if (lessonProgressStorage === "suspend_data") scope.lessonProgress = completed ? "1.000" : "0";
    else delete scope.lessonProgress;
    const root = { ...suspendRoot, geekbangPlayer: scope };
    let serialized = JSON.stringify(root);
    if (serialized.length > 4096) {
      logError("suspend_data capacity exceeded", { sku: courseSku, length: serialized.length });
      return false;
    }
    if (positions.size) {
      const records = [...positions].map(([id, bookmark]) =>
        `${Number(id).toString(36)}:${bookmark.kind === "video" ? "v" : "a"}${bookmark.position.toString(36)}` +
        `${bookmark.audioPosition === undefined ? "" : "," + bookmark.audioPosition.toString(36)};`);
      scope.positions = "";
      let remaining = 4096 - JSON.stringify(root).length;
      let start = records.length;
      // 编码仅含 ASCII，不需 JSON 转义；保留可容纳的最新后缀，淘汰只影响存档。
      while (start > 0 && records[start - 1].length <= remaining) {
        remaining -= records[--start].length;
      }
      if (start < records.length) scope.positions = records.slice(start).join("");
      else delete scope.positions;
      serialized = JSON.stringify(root);
    }
    return safeSetValue("cmi.suspend_data", serialized);
  }

  function flushSessionTime() {
    // session_time 代表当前会话累计时长，commit 时持续覆盖更新，最终由 LMS 在 finish 后并入 total_time。
    // 对应日志：session_time fallback、progress commit
    const value = formatSecondsToSessionTime(sessionLearnSeconds);
    const ok = safeSetValue("cmi.core.session_time", value);
    if (!ok) {
      const legacy = formatSecondsToSessionTimeLegacy(sessionLearnSeconds);
      logInfo("session_time fallback", { value, legacy, sessionLearnSeconds });
      safeSetValue("cmi.core.session_time", legacy);
    }
  }

  function init(sku) {
    // 临时学习及读取失败仍可重试；已读成功后不再读其他窗口的新存档。
    if (initialized && writeEnabled) return true;
    courseSku = String(sku ?? "");
    if (!/^[1-9]\d*$/.test(courseSku)) {
      logError("init invalid sku", { sku });
      return false;
    }
    logInfo("init begin", { sku: courseSku });
    if (!initialized) {
      API = getAPI();
      if (!API) {
        logError("API not found");
        return false;
      }

      let res;
      try {
        res = API.LMSInitialize("");
      } catch (error) {
        logError("LMSInitialize exception", { sku: courseSku });
        return false;
      }
      if (!isScormSuccessResult(res)) {
        const errorCode = getLastErrorCode();
        const errorString = getErrorString(errorCode);
        const diagnostic = getDiagnostic(errorCode);
        logError("LMSInitialize failed", {
          result: res,
          resultType: typeof res,
          errorCode,
          errorString,
          diagnostic,
          apiKeys: Object.keys(API || {}).slice(0, 20),
        });
        return false;
      }

      initialized = true;
    }

    ready = true;
    const suspendResult = getValueResult("cmi.suspend_data");
    const suspendDataRaw = suspendResult.value;
    const suspendDataObj = parseSuspendDataObject(suspendDataRaw);
    if (!suspendResult.supported || suspendDataRaw !== "" && !suspendDataObj) {
      storageStatus = "read_failed";
      logError("suspend_data read failed", { sku: courseSku, errorCode: suspendResult.errorCode });
      return true;
    }
    suspendRoot = suspendDataObj || {};

    const storedScope = suspendDataObj && suspendDataObj.geekbangPlayer && typeof suspendDataObj.geekbangPlayer === "object"
      && !Array.isArray(suspendDataObj.geekbangPlayer)
      ? suspendDataObj.geekbangPlayer
      : null;
    if (suspendRoot.geekbangPlayer !== undefined && !storedScope) {
      storageStatus = "read_failed";
      logError("suspend_data invalid namespace", { sku: courseSku });
      return true;
    }
    const historyMatched = storedScope !== null && String(storedScope.sku) === courseSku;
    const suspendScope = historyMatched ? storedScope : null;
    if (!historyMatched) {
      logInfo("init history discarded", { sku: courseSku, storedSku: storedScope ? storedScope.sku : null });
    }

    const validLegacy = suspendScope && suspendScope.v === undefined &&
      (Number.isFinite(suspendScope.totalLearnSeconds) || Number.isFinite(suspendScope.lessonLocation) ||
        Number.isFinite(Number.parseFloat(suspendScope.lessonProgress)));
    const temporary = { sections, videoMilliseconds, audioMilliseconds, mediaDurations, readingDurations, positions, completed, last };
    if (suspendScope && !(suspendScope.v === undefined ? validLegacy : restoreSections(suspendScope))) {
      storageStatus = "read_failed";
      logError("suspend_data invalid version or state", { sku: courseSku });
      return true;
    }
    if (!suspendScope || suspendScope.v === undefined) {
      sections = {};
      videoMilliseconds = {};
      audioMilliseconds = {};
      mediaDurations = {};
      readingDurations = {};
      positions = new Map();
      completed = false;
      last = null;
    }
    for (const [id, milliseconds] of Object.entries(temporary.audioMilliseconds)) {
      audioMilliseconds[id] = (audioMilliseconds[id] || 0) + milliseconds;
    }
    for (const [id, duration] of Object.entries(temporary.readingDurations)) {
      if (!duration && readingDurations[id] && sections[id] !== 2) sections[id] = 1;
    }
    readingDurations = { ...readingDurations, ...temporary.readingDurations };
    // 恢复历史时，两路各自只加一次当前会话的新增学习量。
    for (const [id, value] of Object.entries(temporary.sections)) {
      const saved = sections[id] || 0;
      const seconds = (saved >= 3 ? saved - 2 : 0) + (value >= 3 ? value - 2 : 0);
      const target = readingDurations[id] ? Math.ceil(readingDurations[id] * 0.98) : 180;
      sections[id] = saved === 2 || value === 2 || seconds >= target ? 2 : seconds > 0 ? seconds + 2 : 1;
    }
    for (const [id, milliseconds] of Object.entries(temporary.videoMilliseconds)) {
      videoMilliseconds[id] = (videoMilliseconds[id] || 0) + milliseconds;
    }
    mediaDurations = { ...mediaDurations, ...temporary.mediaDurations };
    for (const [id, bookmark] of temporary.positions) {
      positions.delete(id);
      positions.set(id, bookmark);
    }
    completed = completed || temporary.completed;
    if (temporary.last) last = temporary.last;
    writeEnabled = true;
    storageStatus = "ok";

    // 只继承明确的完成状态，旧百分比和时长不再用于推断完成或补造小节。
    const lessonStatusResult = getValueResult("cmi.core.lesson_status");
    const status = historyMatched && lessonStatusResult.supported ? lessonStatusResult.value : "";
    completed = completed || status === "completed" || status === "passed";
    lessonStatus = completed ? (status === "passed" ? "passed" : "completed") : "incomplete";
    // 兼容原有 LMS 字段，只写未完成/完成的 0/100，不再推进时间百分比。
    lessonProgressStorage = getValueResult("cmi.core.lesson_progress").supported ? "core" : "suspend_data";
    const savedSeconds = suspendScope ? suspendScope.totalLearnSeconds : null;
    totalLearnSeconds = sessionLearnSeconds + (Number.isFinite(savedSeconds) ? Math.max(0, Math.floor(savedSeconds)) : 0);

    if (catalogIds?.length) {
      const current = new Set(catalogIds);
      for (const id of Object.keys(sections)) if (!current.has(id)) delete sections[id];
      for (const id of Object.keys(videoMilliseconds)) if (!current.has(id)) delete videoMilliseconds[id];
      for (const id of Object.keys(audioMilliseconds)) if (!current.has(id)) delete audioMilliseconds[id];
      for (const id of Object.keys(mediaDurations)) if (!current.has(id)) delete mediaDurations[id];
      for (const id of Object.keys(readingDurations)) if (!current.has(id)) delete readingDurations[id];
      for (const id of positions.keys()) if (!current.has(id)) positions.delete(id);
      if (last && !current.has(last.id)) last = null;
      completed = completed || catalogIds.every(id => optionalCatalogIds.has(id) || sections[id] === 2);
    }
    updateCompletionState();
    if (completed && lessonStatus !== "passed") lessonStatus = "completed";
    // 首次正常存档同时作为写入能力检查；之后不重读其他窗口的状态。
    if (!commit()) storageStatus = "write_failed";
    logInfo("init initialized", { sku: courseSku, lessonStatus, completed, totalLearnSeconds });

    return true;
  }

  function commit() {
    if (!initialized || !writeEnabled) return false;
    const saved = flushSuspendData();
    // 存档写失败时不提交不完整的新进度；下一个正常保存周期再尝试。
    if (!saved) return false;
    flushSessionTime();
    safeSetValue("cmi.core.lesson_location", completed ? "100" : "0");
    if (lessonProgressStorage === "core") safeSetValue("cmi.core.lesson_progress", completed ? "1.000" : "0");
    safeSetValue("cmi.core.lesson_status", lessonStatus);
    return commitToLms("progress commit");
  }

  function finish() {
    if (!ready) return;
    if (initialized) {
      if (writeEnabled) {
        safeSetValue("cmi.core.exit", "suspend");
        commit();
      }
      finishToLms("progress finish");
    }
    initialized = false;
    ready = false;
    if (typeof clearInterval === "function") {
      clearInterval(heartbeatId);
    }
    sessionStarted = false;
    heartbeatId = null;
  }

  // 完成判定只更新内存，保存和通知由入口负责，避免一次更新重复提交。
  function updateCompletionState() {
    for (const [id, duration] of Object.entries(readingDurations)) {
      if (duration > 0 && sections[id] >= 3 && sections[id] - 2 >= Math.ceil(duration * 0.98)) sections[id] = 2;
    }
    // 选学仍保留明细和续学位置，但不阻塞整课完成；非空全选学目录可直接完成。
    if (!ready || completed || !catalogIds?.length ||
        !catalogIds.every(id => optionalCatalogIds.has(id) || sections[id] === 2)) return false;
    completed = true;
    if (lessonStatus !== "passed") lessonStatus = "completed";
    return true;
  }

  function complete() {
    if (!updateCompletionState()) return;
    commit();
    if (onStateChange) onStateChange(getState());
  }

  function useTemporary(sku) {
    if (ready || !normalizeId(sku)) return;
    courseSku = String(sku);
    ready = true;
    writeEnabled = false;
    storageStatus = "unavailable";
  }

  function startSession(options) {
    if (!ready || sessionStarted) return;
    onStateChange = typeof options?.onStateChange === "function" ? options.onStateChange : null;
    sessionStarted = true;
    if (!flushHandlersBound) {
      flushHandlersBound = true;
      window.addEventListener("pagehide", (event) => {
        // bfcache 会复用当前运行时，不能提前结束 LMS 会话，否则返回后无法继续保存。
        // 退出也由 pagehide 处理，避免 unload 监听影响浏览器的 bfcache 资格。
        if (event.persisted) commit();
        else finish();
      });
    }
    heartbeat();
    commit();
    if (onStateChange) onStateChange(getState());
  }

  function heartbeat() {
    if (heartbeatId !== null) return;
    heartbeatId = setInterval(() => {
      if (ready) commit();
    }, 10000);
  }

  return {
    init,
    getValue,
    commit,
    finish,
    complete,
    startSession,
    heartbeat,
    getState,
    setCatalog,
    updateSection,
    useTemporary,
  };
})();
