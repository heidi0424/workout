    const DEFAULT_GAS_URL = "https://script.google.com/macros/s/AKfycbyDG6HC4CkoIptW844j4uD0oElEaeQjX13yFeYWb0ozpt_ZDg_E_Yt0f4YZUE-Qy1s8vA/exec";
    const STORAGE_KEY_ITEMS = "workout_tracker_dynamic_items_v3";
    const STORAGE_KEY_MACHINES = "workout_tracker_dynamic_machines_v1";
    const STORAGE_KEY_SYNC_QUEUE = "workout_tracker_sync_queue_v1";
    const STORAGE_KEY_PRE_SYNC_ITEMS = "workout_tracker_pre_auto_sync_items";
    const STORAGE_KEY_PHOTO_QUEUE = "workout_tracker_photo_queue_v1";
    const PRIVATE_PHOTO_API = "/api/photos";
    const localPhotoPattern = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;
    const SYNC_VERSION = "workout-auto-sync-v1";
    const LEGACY_KEYS_ITEMS = ["workout_tracker_dynamic_items_v2", "workout_tracker_dynamic_items_v1", "workout_tracker_20261116_v7_items"];
    const LEGACY_KEYS_MACHINES = ["workout_tracker_20261116_v7_machines"];

    const DEFAULT_CARDIO_OPTIONS = [
      "跑步機爬坡 / 跑步 / 有氧",
      "跑步機坡度慢跑（HYROX 疲勞轉換跑）",
      "跑步機坡度慢跑（HARCO 緩和收尾）",
      "皮拉提斯",
      "瑜珈",
      "樂活極球",
      "晚間羽球專項對打與場上移動",
      "HYROX 混合體能課程",
      "戶外跑步",
      "滑步機 / 飛輪"
    ];

    let items = [];
    let machines = [];
    let selectedWeekIdx = 0;
    let selectedDate = "";
    let selectedMachineFilter = "ALL";
    let editingMachineId = null;
    let currentFormRating = 5;
    let currentFormPhoto = "";
    let formPhotoChanged = false;
    let photoAuthorized = false;
    let photoSyncRunning = false;
    let photoSessionRevision = 0;
    let photoIndex = new Map();
    let photoChanges = new Map();
    let pendingEdits = { schedule: {}, machines: {}, copiedDays: {} };
    let syncTimer;
    let syncRunning = false;

    function getExerciseVideo(item) {
      const video = String(item.video || "").trim();
      const oldVideo = /^https?:\/\/(?:(?:www\.)?youtube\.com\/watch\?v=4I2zlJyljHU(?:[&#].*)?|youtu\.be\/4I2zlJyljHU(?:[?#].*)?)$/i;
      return String(item.name || "").trim() === "靠牆單臂胸大肌伸展" && oldVideo.test(video)
        ? "https://www.youtube.com/watch?v=hfU0EDpFwDw"
        : video;
    }

    function getDynamicCardioOptions() {
      const set = new Set(DEFAULT_CARDIO_OPTIONS);
      items.forEach(it => {
        if ((it.rowType === "cardio" || it.rowType === "sport") && String(it.name || "").trim()) {
          set.add(String(it.name).trim());
        }
      });
      return Array.from(set);
    }

    function normalizeSheetDate(val) {
      const s = String(val ?? "").trim();
      if (!s) return "";
      if (/^\d{4}-\d{2}-\d{2}T/.test(s)) {
        const d = new Date(s);
        if (!isNaN(d.getTime())) {
          return new Intl.DateTimeFormat("en-CA", {
            timeZone: "Asia/Taipei",
            year: "numeric",
            month: "2-digit",
            day: "2-digit"
          }).format(d).replace(/-/g, "/");
        }
      }
      const m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
      if (m) {
        return `${m[1]}/${m[2].padStart(2, "0")}/${m[3].padStart(2, "0")}`;
      }
      return s;
    }

    function classifyRowType(phaseStr, basisStr) {
      const p = String(phaseStr || "").trim();
      const b = String(basisStr || "").trim();
      if (p.includes("午間散步") || b.includes("步行紀錄")) return "walk";
      if (p.includes("專項有氧") || p.includes("有氧活動") || b.includes("有氧紀錄")) return "cardio";
      if (p.includes("COROS") || b.includes("COROS")) return "sport";
      if (p.includes("自訂加練")) return "custom";
      return "strength";
    }

    function inferShortTag(moduleStr) {
      const m = String(moduleStr || "");
      if (m.includes("推日")) return "推日";
      if (m.includes("拉日")) return "拉日";
      if (m.includes("腿日")) return "腿日";
      if (m.includes("羽球")) return "羽球";
      if (m.includes("Zone 2") || m.includes("有氧")) return "有氧";
      if (m.includes("HARCO")) return "HARCO";
      if (m.includes("HYROX")) return "HYROX";
      if (m.includes("主動恢復")) return "修復";
      if (m.includes("動態恢復") || m.includes("休息")) return "恢復";
      return m.slice(0, 4) || "訓練";
    }

    function getTodayDateStr() {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: "Asia/Taipei",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).format(new Date()).replace(/-/g, "/");
    }

    function getAllDaysMeta() {
      const seen = new Map();
      items.forEach(it => {
        if (!it.date) return;
        if (!seen.has(it.date)) {
          seen.set(it.date, {
            date: it.date,
            weekday: it.weekday || "",
            shortTag: inferShortTag(it.module),
            module: it.module || ""
          });
        }
      });
      return Array.from(seen.values()).sort((a, b) => a.date.localeCompare(b.date));
    }

    function getWeeksList() {
      const allDays = getAllDaysMeta();
      const weeks = [];
      for (let i = 0; i < allDays.length; i += 7) {
        const slice = allDays.slice(i, i + 7);
        if (slice.length > 0) {
          const start = slice[0].date;
          const end = slice[slice.length - 1].date;
          weeks.push({
            index: weeks.length,
            label: `${start.slice(5)} – ${end.slice(5)}`,
            fullRange: `${start} – ${end}`,
            days: slice
          });
        }
      }
      return weeks;
    }

    function pickBestDateAndWeek(preserveCurrent = false) {
      const weeks = getWeeksList();
      if (weeks.length === 0) {
        selectedWeekIdx = 0;
        selectedDate = "";
        return;
      }
      if (preserveCurrent && selectedDate) {
        for (const w of weeks) {
          if (w.days.some(d => d.date === selectedDate)) {
            selectedWeekIdx = w.index;
            return;
          }
        }
      }
      const todayStr = getTodayDateStr();
      for (const w of weeks) {
        const hit = w.days.find(d => d.date === todayStr);
        if (hit) {
          selectedWeekIdx = w.index;
          selectedDate = hit.date;
          return;
        }
      }
      const latestWeek = weeks[weeks.length - 1];
      selectedWeekIdx = latestWeek.index;
      selectedDate = latestWeek.days[0].date;
    }

    function parseSheetScheduleRows(sheetRows) {
      const loaded = [];
      sheetRows.forEach((r, idx) => {
        const dateStr = normalizeSheetDate(r[0]);
        if (!dateStr) return;
        const weekday = String(r[1] || "").trim();
        const module = String(r[2] || "").trim();
        const phase = String(r[3] || "").trim();
        const name = String(r[4] || "").trim();
        const basis = String(r[5] || "總重 (含槓/機重)").trim();
        const rowType = classifyRowType(phase, basis);

        const item = {
          id: "row_" + (idx + 1),
          date: dateStr,
          weekday,
          module,
          rowType,
          phase,
          name,
          basis,
          baseKg: r[6] !== "" && r[6] !== null && r[6] !== undefined ? Number(r[6]) : 0,
          targetSets: r[7] !== "" && r[7] !== null && r[7] !== undefined ? r[7] : "",
          targetReps: r[8] !== "" && r[8] !== null && r[8] !== undefined ? String(r[8]) : "",
          rest: r[9] !== "" && r[9] !== null && r[9] !== undefined ? String(r[9]) : "-",
          rpe: r[10] !== "" && r[10] !== null && r[10] !== undefined ? String(r[10]) : "",
          cues: String(r[11] || "").trim(),
          muscles: String(r[12] || "").trim(),
          video: String(r[13] || "").trim(),
          addedWeight: r[14] !== "" && r[14] !== null && r[14] !== undefined ? String(r[14]) : "",
          unit: String(r[15] ?? "").trim() || (rowType === "sport" || rowType === "cardio" ? "" : "KG"),
          actualSets: r[16] !== "" && r[16] !== null && r[16] !== undefined ? String(r[16]) : "",
          actualReps: r[17] !== "" && r[17] !== null && r[17] !== undefined ? String(r[17]) : "",
          walkKm: r[20] !== "" && r[20] !== null && r[20] !== undefined ? String(r[20]) : "",
          walkMin: r[21] !== "" && r[21] !== null && r[21] !== undefined ? String(r[21]) : "",
          cardioKm: r[23] !== "" && r[23] !== null && r[23] !== undefined ? String(r[23]) : "",
          cardioMin: r[24] !== "" && r[24] !== null && r[24] !== undefined ? String(r[24]) : "",
          cardioSpeed: r[25] !== "" && r[25] !== null && r[25] !== undefined ? String(r[25]) : "",
          cardioIncline: r[26] !== "" && r[26] !== null && r[26] !== undefined ? String(r[26]) : "",
          sportMin: "",
          sportAvgHr: "",
          sportKcal: "",
          sportLoad: "",
          sportAerobicTe: "",
          sportAnaerobicTe: "",
          sportNotes: "",
          status: String(r[27] || "").trim() || (rowType === "cardio" && !name ? "➖ 今日無有氧" : "⬜ 待完成")
        };

        if (rowType === "sport" || rowType === "cardio") {
          item.sportMin = r[24] !== "" && r[24] !== null && r[24] !== undefined ? String(r[24]) : "";
          const noteCol = String(r[11] || "");
          const hrMatch = noteCol.match(/均心率\s*(\d+)/);
          const kcalMatch = noteCol.match(/卡路里\s*(\d+)/);
          const loadMatch = noteCol.match(/訓練負荷\s*(\d+)/);
          const aeroMatch = noteCol.match(/有氧效果\s*([\d.]+)/);
          const anaeroMatch = noteCol.match(/無氧效果\s*([\d.]+)/);
          if (hrMatch) item.sportAvgHr = hrMatch[1];
          if (kcalMatch) item.sportKcal = kcalMatch[1];
          if (loadMatch) item.sportLoad = loadMatch[1];
          if (aeroMatch) item.sportAerobicTe = aeroMatch[1];
          if (anaeroMatch) item.sportAnaerobicTe = anaeroMatch[1];
          if (noteCol && !noteCol.startsWith("均心率")) {
            const parts = noteCol.split("｜");
            if (parts.length > 1 && !parts[0].includes("均心率")) {
              item.sportNotes = parts[0].trim();
            }
          }
        }
        loaded.push(item);
      });
      return loaded;
    }

    function loadLocalCache() {
      try {
        let savedRaw = localStorage.getItem(STORAGE_KEY_ITEMS);
        if (!savedRaw) {
          for (const k of LEGACY_KEYS_ITEMS) {
            if (localStorage.getItem(k)) { savedRaw = localStorage.getItem(k); break; }
          }
        }
        const parsed = JSON.parse(savedRaw || "[]");
        if (Array.isArray(parsed) && parsed.length > 0) {
          items = parsed.map(it => ({
            ...it,
            rowType: classifyRowType(it.phase, it.basis)
          }));
        }
      } catch (e) {
        items = [];
      }

      try {
        let mRaw = localStorage.getItem(STORAGE_KEY_MACHINES);
        if (!mRaw) {
          for (const k of LEGACY_KEYS_MACHINES) {
            if (localStorage.getItem(k)) { mRaw = localStorage.getItem(k); break; }
          }
        }
        const parsedM = JSON.parse(mRaw || "[]");
        machines = Array.isArray(parsedM) ? parsedM : [];
      } catch (e) {
        machines = [];
      }

      try {
        const saved = JSON.parse(localStorage.getItem(STORAGE_KEY_SYNC_QUEUE) || "null");
        if (saved) pendingEdits = { ...pendingEdits, ...saved };
        else {
          if (items.length && !localStorage.getItem(STORAGE_KEY_PRE_SYNC_ITEMS)) {
            localStorage.setItem(STORAGE_KEY_PRE_SYNC_ITEMS, JSON.stringify(items));
          }
          machines = machines.map(machine => ({ ...machine, localOnly: true }));
          saveSyncQueue();
        }
      } catch (e) {
        // Keep the already loaded workout cache if the queue cannot be read.
      }
      pickBestDateAndWeek(false);
    }

    function saveState() {
      try {
        localStorage.setItem(STORAGE_KEY_ITEMS, JSON.stringify(items));
        localStorage.setItem(STORAGE_KEY_MACHINES, JSON.stringify(machines));
      } catch (e) {
        showToast("⚠️ 本機儲存空間已滿，請清理舊照片或匯出備份");
      }
    }

    function scheduleKey(row) {
      return normalizeSheetDate(row[0]) + "||" + String(row[3] ?? "").trim();
    }

    function hasPendingEdits() {
      return Object.values(pendingEdits).some(edits => Object.keys(edits).length > 0);
    }

    function nextWeekDate(date) {
      if (!/^\d{4}\/\d{2}\/\d{2}$/.test(date)) return "";
      const day = new Date(date.replace(/\//g, "-") + "T00:00:00Z");
      if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10).replace(/-/g, "/") !== date) return "";
      day.setUTCDate(day.getUTCDate() + 7);
      return day.toISOString().slice(0, 10).replace(/-/g, "/");
    }

    function buildNextWeekCopy(week) {
      const occupied = new Set(items.map(item => item.date));
      const copies = new Map();
      for (const day of week.days) {
        const date = nextWeekDate(day.date);
        if (date && !occupied.has(date) && !pendingEdits.copiedDays[date]) copies.set(day.date, { date, rows: [] });
      }
      const sourceItems = items.filter(item => copies.has(item.date));
      const rows = build28ColRows(sourceItems).slice(1);
      sourceItems.forEach((item, index) => {
        const copy = copies.get(item.date);
        const plan = rows[index].slice(0, 14).concat(Array(14).fill(""));
        plan[0] = copy.date;
        if (item.rowType === "sport" || item.rowType === "cardio" || item.rowType === "custom") plan[11] = "";
        if (item.rowType === "custom") {
          plan[4] = "";
          plan[5] = "總重 (含槓/機重)";
          plan[6] = 0;
        }
        copy.rows.push(plan);
      });
      return [...copies.values()].filter(copy => copy.rows.length > 0);
    }

    function copySelectedWeek() {
      const week = getWeeksList()[selectedWeekIdx];
      if (!week) return;
      const copies = buildNextWeekCopy(week);
      if (!copies.length) {
        showToast("下週對應日期已排課或正在同步");
        return;
      }
      if (!confirm("將這週菜單複製到下週？已排好的日期會保留，實際訓練紀錄會留空。")) return;
      copies.forEach(copy => { pendingEdits.copiedDays[copy.date] = copy; });
      saveSyncQueue();
      document.getElementById("saveStatus").textContent = "待同步";
      showToast("已排入同步，下週菜單會在同步後顯示");
      scheduleSync(0);
    }

    function setPhotoSyncStatus(message, canSignIn = false) {
      document.getElementById("photoSyncStatus").textContent = message;
      document.getElementById("photoSignIn").hidden = !canSignIn;
      document.getElementById("photoSignOut").hidden = !photoAuthorized;
    }

    function machinePhotoUrl(id, version = "") {
      return PRIVATE_PHOTO_API + "?machine=" + encodeURIComponent(id) + "&v=" + encodeURIComponent(version);
    }

    function machinePhotoSource(machine) {
      const localPhoto = localPhotoPattern.test(machine.photo || "") ? machine.photo : "";
      const pending = photoChanges.get(machine.id);
      if (pending) return pending.remove ? "" : localPhoto;
      const remote = photoIndex.get(machine.id);
      if (photoAuthorized && remote) return remote.active ? machinePhotoUrl(machine.id, remote.updated) : "";
      return localPhoto;
    }

    function savePhotoChanges() {
      try {
        localStorage.setItem(STORAGE_KEY_PHOTO_QUEUE, JSON.stringify([...photoChanges]));
      } catch {
        setPhotoSyncStatus("本機空間不足，請保留此頁至照片同步完成");
      }
    }

    function queuePhotoChange(id, remove) {
      photoChanges.set(id, { remove });
      savePhotoChanges();
      refreshMachinePhotos();
    }

    function renderPhotoLibrary() {
      if (document.getElementById("tab-machines").classList.contains("active")) renderMachineLibrary();
    }

    function endPhotoSession() {
      photoAuthorized = false;
      photoIndex.clear();
      document.getElementById("imgModal").classList.remove("open");
      document.getElementById("modalImgEl").removeAttribute("src");
      document.getElementById("mPhotoPreview").removeAttribute("src");
      document.getElementById("mPhotoPreviewWrap").style.display = "none";
      renderPhotoLibrary();
    }

    async function refreshMachinePhotos() {
      if (photoSyncRunning || document.hidden) return;
      if (navigator.onLine === false) {
        setPhotoSyncStatus(photoChanges.size ? "照片已存在本機・連線後同步" : "離線時可看本機照片");
        return;
      }
      photoSyncRunning = true;
      const sessionRevision = photoSessionRevision;
      try {
        const list = await fetch(PRIVATE_PHOTO_API, { cache: "no-store", signal: AbortSignal.timeout(15000) });
        if (sessionRevision !== photoSessionRevision) return;
        if (list.status === 401) {
          if (photoAuthorized) endPhotoSession();
          setPhotoSyncStatus("登入同一個 Google 帳號，即可在其他裝置查看器械照片。", true);
          return;
        }
        if (list.status === 503 || list.status === 404) {
          setPhotoSyncStatus("私人照片同步尚未啟用，照片會先存於這台裝置。");
          return;
        }
        if (!list.ok) throw new Error("Photo list unavailable");
        const data = await list.json();
        if (sessionRevision !== photoSessionRevision) return;
        const previous = photoIndex;
        photoAuthorized = true;
        photoIndex = new Map(data.photos.map(photo => [photo.machineId, photo]));
        if (JSON.stringify([...previous]) !== JSON.stringify([...photoIndex])) renderPhotoLibrary();

        for (const machine of machines) {
          if (localPhotoPattern.test(machine.photo || "") && !photoIndex.has(machine.id) && !photoChanges.has(machine.id)) {
            photoChanges.set(machine.id, { remove: false });
          }
        }
        if (photoChanges.size) {
          savePhotoChanges();
          setPhotoSyncStatus("正在同步照片…");
        }
        for (const [id, change] of [...photoChanges]) {
          const localPhoto = machines.find(machine => machine.id === id)?.photo || "";
          if (!change.remove && !localPhotoPattern.test(localPhoto)) continue;
          const result = await fetch(machinePhotoUrl(id), {
            method: change.remove ? "DELETE" : "PUT",
            ...(!change.remove ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ jpeg: localPhoto.split(",")[1] })
            } : {}),
            signal: AbortSignal.timeout(20000)
          });
          if (sessionRevision !== photoSessionRevision) return;
          if (result.status === 401) {
            endPhotoSession();
            setPhotoSyncStatus("請重新登入 Google，待同步照片仍在這台裝置。", true);
            return;
          }
          if (!result.ok) throw new Error("Photo was not saved");
          const photo = await result.json();
          if (sessionRevision !== photoSessionRevision) return;
          photoIndex.set(id, photo);
          if (photoChanges.get(id) === change) {
            photoChanges.delete(id);
            savePhotoChanges();
          }
        }
        setPhotoSyncStatus(photoChanges.size ? "照片待同步" : "照片已同步");
        if (JSON.stringify([...previous]) !== JSON.stringify([...photoIndex])) renderPhotoLibrary();
      } catch {
        if (sessionRevision === photoSessionRevision) {
          setPhotoSyncStatus(photoChanges.size ? "照片待同步・將自動重試" : "暫時無法讀取雲端照片", !photoAuthorized);
        }
      } finally {
        photoSyncRunning = false;
      }
    }

    function saveSyncQueue() {
      try {
        localStorage.setItem(STORAGE_KEY_SYNC_QUEUE, JSON.stringify(pendingEdits));
      } catch (err) {
        showToast("本機儲存空間不足，請保留此頁至同步完成");
      }
    }

    function scheduleSync(delay = 800) {
      clearTimeout(syncTimer);
      syncTimer = setTimeout(syncFromCloud, delay);
    }

    function queueWorkoutEdit(item, previousRow) {
      const row = build28ColRows([item])[1];
      const key = scheduleKey(row);
      const columns = new Set(pendingEdits.schedule[key]?.columns);
      row.forEach((value, col) => {
        if (String(value ?? "") !== String(previousRow?.[col] ?? "")) columns.add(col);
      });
      if (columns.size === 0) return;
      pendingEdits.schedule[key] = { row, columns: [...columns] };
      saveSyncQueue();
      document.getElementById("saveStatus").textContent = "待同步";
      scheduleSync();
    }

    function queueMachineEdit(machine) {
      const { photo, localOnly, ...record } = machine;
      pendingEdits.machines[machine.id] = record;
      saveSyncQueue();
      document.getElementById("saveStatus").textContent = "待同步";
      scheduleSync();
    }

    function applyCloudSnapshot(data) {
      const rows = data.schedule.slice(1);
      const indices = new Map(rows.map((row, index) => [scheduleKey(row), index]));
      for (const [key, edit] of Object.entries(pendingEdits.schedule)) {
        const index = indices.get(key) ?? rows.length;
        const current = rows[index]?.slice() || edit.row.slice();
        edit.columns.forEach(col => { current[col] = edit.row[col]; });
        rows[index] = current;
      }
      const cloudItems = parseSheetScheduleRows(rows);
      if (cloudItems.length > 0) items = cloudItems;

      const localMachines = new Map(machines.map(machine => [machine.id, machine]));
      const cloudMachines = new Map(data.machines.slice(1).flatMap((r, i) => {
        if (!String(r[2] ?? "").trim()) return [];
        const id = String(r[0] || ("mach_cloud_" + i));
        return [[id, {
          id, date: normalizeSheetDate(r[1]), name: String(r[2]),
          category: String(r[3] || "有氧與功能器械"), rating: Number(r[4]) || 5,
          setup: String(r[5] || ""), notes: String(r[6] || "")
        }]];
      }));
      for (const local of localMachines.values()) {
        if (local.localOnly && !cloudMachines.has(local.id)) cloudMachines.set(local.id, local);
      }
      for (const record of Object.values(pendingEdits.machines)) {
        if (record.deleted) cloudMachines.delete(record.id);
        else cloudMachines.set(record.id, record);
      }
      const updatedMachines = [...cloudMachines.values()].map(machine => ({
        ...machine,
        photo: localMachines.get(machine.id)?.photo || ""
      }));
      const machinesChanged = JSON.stringify(machines) !== JSON.stringify(updatedMachines);
      machines = updatedMachines;
      pickBestDateAndWeek(true);
      saveState();
      renderScheduleView();
      if (document.getElementById("tab-overview").classList.contains("active")) renderOverviewView();
      if (machinesChanged) renderPhotoLibrary();
    }

    async function syncFromCloud({ keepalive = false } = {}) {
      if (syncRunning) return false;
      const status = document.getElementById("saveStatus");
      if (navigator.onLine === false) {
        status.textContent = hasPendingEdits() ? "離線・待同步" : "離線快取";
        return false;
      }
      syncRunning = true;
      let retry = false;
      try {
        if (hasPendingEdits()) {
          status.textContent = "同步中…";
          const schedule = Object.entries(pendingEdits.schedule);
          const machineChanges = Object.entries(pendingEdits.machines);
          const copiedDays = Object.values(pendingEdits.copiedDays);
          const body = JSON.stringify({
            autoSyncVersion: SYNC_VERSION,
            scheduleHeader: build28ColRows([])[0],
            scheduleChanges: schedule.map(([, edit]) => edit),
            machineChanges: machineChanges.map(([, record]) => record),
            copiedDays
          });
          const result = await fetch(DEFAULT_GAS_URL, {
            method: "POST",
            signal: AbortSignal.timeout(20000),
            keepalive: keepalive && new TextEncoder().encode(body).length < 60000,
            headers: { "Content-Type": "text/plain;charset=utf-8" },
            body
          });
          const reply = await result.json();
          if (!result.ok || reply.status !== "saved" || reply.syncVersion !== SYNC_VERSION) {
            throw new Error("Cloud did not acknowledge the update");
          }
          for (const [key, edit] of schedule) {
            const current = pendingEdits.schedule[key];
            const unsettled = current.columns.filter(col =>
              !edit.columns.includes(col) || String(current.row[col] ?? "") !== String(edit.row[col] ?? ""));
            if (unsettled.length > 0) current.columns = unsettled;
            else delete pendingEdits.schedule[key];
          }
          for (const [key, record] of machineChanges) {
            if (pendingEdits.machines[key] === record) delete pendingEdits.machines[key];
          }
          if (copiedDays.length) {
            const receipt = reply.copyResult;
            if (!Number.isInteger(receipt?.created) || !Number.isInteger(receipt?.skipped) ||
                receipt.created < 0 || receipt.skipped < 0 || receipt.created + receipt.skipped !== copiedDays.length) {
              saveSyncQueue();
              throw new Error("Cloud did not acknowledge the week copy");
            }
            copiedDays.forEach(copy => { delete pendingEdits.copiedDays[copy.date]; });
            showToast(receipt.created ? `已建立下週菜單，共 ${receipt.created} 天` : "下週對應日期已有菜單");
          }
          saveSyncQueue();
        }
        if (document.hidden) return true;
        const result = await fetch(DEFAULT_GAS_URL, { cache: "no-store", signal: AbortSignal.timeout(20000) });
        const data = await result.json();
        if (!result.ok || data.status !== "ok" || !Array.isArray(data.schedule) || !Array.isArray(data.machines)) {
          throw new Error("Cloud data is unavailable");
        }
        if (!document.activeElement?.matches("main input, main textarea, main select")) applyCloudSnapshot(data);
        status.textContent = hasPendingEdits() ? "待同步" : "雲端已同步";
        return true;
      } catch (err) {
        retry = true;
        status.textContent = hasPendingEdits() ? "待同步・將重試" : "暫無連線";
        return false;
      } finally {
        syncRunning = false;
        if (retry || hasPendingEdits()) scheduleSync(retry ? 15000 : 800);
      }
    }

    function showToast(msg) {
      const t = document.getElementById("toastEl");
      t.textContent = msg;
      t.style.display = "block";
      clearTimeout(t._timer);
      t._timer = setTimeout(() => { t.style.display = "none"; }, 2600);
    }

    function calcStrengthMetrics(item) {
      if (item.basis === "自重 / 彈力帶" || item.basis === "時間 / 距離" || item.rowType === "walk" || item.rowType === "cardio" || item.rowType === "sport") {
        return { effectiveKg: 0, volumeKg: 0 };
      }
      const rawStr = String(item.addedWeight ?? "").trim();
      if (rawStr === "") {
        return { effectiveKg: 0, volumeKg: 0 };
      }
      const addedNum = parseFloat(rawStr) || 0;
      const baseNum = parseFloat(item.baseKg) || 0;
      const weightKg = item.unit === "LB" ? addedNum * 0.45359237 : addedNum;
      const multSingle = item.basis === "單支啞鈴 (×2)" ? 2 : 1;
      const effectiveKg = Math.round((weightKg * multSingle + baseNum) * 100) / 100;

      const sets = parseFloat(item.actualSets) || 0;
      const reps = parseFloat(item.actualReps) || 0;
      const multSide = item.basis === "單邊計重 (×2)" ? 2 : 1;
      const volumeKg = Math.round(effectiveKg * sets * reps * multSide * 10) / 10;
      return { effectiveKg, volumeKg };
    }

    function calcWalkSpeed(item) {
      const km = parseFloat(item.walkKm) || 0;
      const min = parseFloat(item.walkMin) || 0;
      if (km <= 0 || min <= 0) return 0;
      return Math.round((km / (min / 60)) * 100) / 100;
    }

    function walkSpeedWarning(item, speed) {
      const limit = Number(String(item.rpe ?? "").match(/(?:≤|不超過)\s*(\d+(?:\.\d+)?)\s*km\/h/i)?.[1]);
      return speed > limit ? `⚠️ 建議步速不超過 ${limit} km/h，目前是 ${speed} km/h。` : "";
    }

    function strengthMeasurement(item) {
      if (item.basis !== "時間 / 距離") return null;
      const metric = String(item.targetReps ?? "").trim().match(/^(\d+(?:\.\d+)?)\s*(公尺|公里|km|m|秒|分鐘)$/);
      if (!metric) return null;
      const [, amount, unit] = metric;
      const displayUnit = unit === "m" ? "公尺" : unit === "km" ? "公里" : unit;
      return {
        amount,
        label: `實際${unit === "秒" || unit === "分鐘" ? "時間" : "距離"} (每組${displayUnit})`,
        step: displayUnit === "公里" || amount.includes(".") ? 0.01 : 1
      };
    }

    function findPreviousCompletedRecord(currentItem) {
      const targetName = String(currentItem.name || "").trim();
      if (!targetName) return null;
      const candidates = items
        .filter(x =>
          x.id !== currentItem.id &&
          x.date < currentItem.date &&
          String(x.name || "").trim() === targetName &&
          x.status === "✅ 已完成"
        )
        .sort((a, b) => b.date.localeCompare(a.date));
      return candidates.length > 0 ? candidates[0] : null;
    }

    function getDayStats(dateStr) {
      const dayItems = items.filter(x => x.date === dateStr);
      let validCount = 0;
      let doneCount = 0;
      let totalVol = 0;
      let walkKm = 0;
      let walkMin = 0;
      let cardioKm = 0;
      let cardioMin = 0;
      let cardioSpeed = 0;
      let cardioIncline = 0;
      let cardioDone = false;
      let sportMin = 0;
      let sportKcal = 0;
      let sportAvgHr = 0;
      let sportLoad = 0;

      dayItems.forEach(it => {
        const isBlankCustom = it.rowType === "custom" && String(it.name || "").trim() === "";
        const isNoCardio = it.rowType === "cardio" && it.status === "➖ 今日無有氧";
        if (!isBlankCustom && !isNoCardio) {
          validCount++;
          if (it.status === "✅ 已完成") doneCount++;
        }
        if (it.rowType === "strength" || (it.rowType === "custom" && !isBlankCustom)) {
          totalVol += calcStrengthMetrics(it).volumeKg;
        }
        if (it.rowType === "walk") {
          walkKm += parseFloat(it.walkKm) || 0;
          walkMin += parseFloat(it.walkMin) || 0;
        }
        if (it.rowType === "cardio") {
          cardioKm += parseFloat(it.cardioKm) || 0;
          if (!String(it.sportMin ?? "").trim()) cardioMin += parseFloat(it.cardioMin) || 0;
          cardioSpeed = parseFloat(it.cardioSpeed) || 0;
          cardioIncline = parseFloat(it.cardioIncline) || 0;
          sportMin += parseFloat(it.sportMin) || 0;
          sportKcal += parseFloat(it.sportKcal) || 0;
          if ((parseFloat(it.sportAvgHr) || 0) > 0) sportAvgHr = parseFloat(it.sportAvgHr) || 0;
          sportLoad += parseFloat(it.sportLoad) || 0;
          if (it.status === "✅ 已完成") cardioDone = true;
        }
        if (it.rowType === "sport") {
          sportMin += parseFloat(it.sportMin) || 0;
          sportKcal += parseFloat(it.sportKcal) || 0;
          if ((parseFloat(it.sportAvgHr) || 0) > 0) sportAvgHr = parseFloat(it.sportAvgHr) || 0;
          sportLoad += parseFloat(it.sportLoad) || 0;
        }
      });

      const walkSpeed = walkMin > 0 ? Math.round((walkKm / (walkMin / 60)) * 100) / 100 : 0;
      const rate = validCount > 0 ? Math.round((doneCount / validCount) * 100) : 0;
      return {
        validCount,
        doneCount,
        rate,
        totalVol: Math.round(totalVol * 10) / 10,
        walkKm: Math.round(walkKm * 100) / 100,
        walkMin: Math.round(walkMin),
        walkSpeed,
        cardioKm: Math.round(cardioKm * 100) / 100,
        cardioMin: Math.round(cardioMin),
        cardioSpeed,
        cardioIncline,
        cardioDone,
        sportMin: Math.round(sportMin),
        sportKcal: Math.round(sportKcal),
        sportAvgHr,
        sportLoad: Math.round(sportLoad)
      };
    }

    function renderWeekSwitcher(targetElId, onWeekChange) {
      const weeks = getWeeksList();
      const bar = document.getElementById(targetElId);
      const subEl = document.getElementById("appSubtitle");

      if (weeks.length === 0) {
        if (subEl) subEl.textContent = "正在從雲端試算表載入課表...";
        if (bar) bar.innerHTML = `<span style="font-size:0.82rem; color:#64748b; font-weight:700;">⏳ 正在連線試算表載入最新課表...</span>`;
        return;
      }

      if (selectedWeekIdx >= weeks.length) selectedWeekIdx = weeks.length - 1;
      const currentWeek = weeks[selectedWeekIdx];
      if (subEl && currentWeek) {
        subEl.textContent = `${currentWeek.fullRange}（全資料庫共 ${weeks.length} 週）｜步行 × 重訓 × 有氧`;
      }

      if (!bar) return;
      const todayStr = getTodayDateStr();
      bar.innerHTML = `
        <span style="font-size:0.78rem; font-weight:700; color:#475569;">📅 週次與歷史切換：</span>
        <div class="week-pills">
          ${weeks.map(w => `
            <button type="button" class="week-pill ${w.index === selectedWeekIdx ? "active" : ""}" data-widx="${w.index}">
              第 ${w.index + 1} 週（${w.label}）
            </button>
          `).join("")}
          <button type="button" class="btn btn-outline btn-sm" id="${targetElId}_todayBtn">🎯 今日 (${todayStr.slice(5)})</button>
          ${targetElId === "weekSwitcherBar" ? '<button type="button" class="btn btn-outline btn-sm" id="copyNextWeekBtn">複製到下週</button>' : ""}
        </div>
      `;

      bar.querySelectorAll("[data-widx]").forEach(btn => {
        btn.addEventListener("click", () => {
          selectedWeekIdx = parseInt(btn.dataset.widx, 10);
          const w = weeks[selectedWeekIdx];
          if (w && !w.days.some(d => d.date === selectedDate)) {
            selectedDate = w.days[0].date;
          }
          onWeekChange();
        });
      });

      const todayBtn = document.getElementById(`${targetElId}_todayBtn`);
      if (todayBtn) {
        todayBtn.addEventListener("click", () => {
          pickBestDateAndWeek(false);
          onWeekChange();
        });
      }
      bar.querySelector("#copyNextWeekBtn")?.addEventListener("click", copySelectedWeek);
    }

    function renderDayStrip() {
      renderWeekSwitcher("weekSwitcherBar", renderScheduleView);
      const weeks = getWeeksList();
      const strip = document.getElementById("dayStrip");
      if (weeks.length === 0) {
        strip.innerHTML = "";
        return;
      }
      const currentWeek = weeks[selectedWeekIdx] || { days: [] };
      const todayStr = getTodayDateStr();
      strip.innerHTML = currentWeek.days.map(d => {
        const st = getDayStats(d.date);
        const active = d.date === selectedDate ? "active" : "";
        const isToday = d.date === todayStr ? "is-today" : "";
        return `
          <div class="day-pill ${active} ${isToday}" data-date="${d.date}">
            <span class="wk">${d.weekday}${d.date === todayStr ? "・今" : ""}</span>
            <span class="dt">${d.date.slice(5)}</span>
            <span class="tag">${d.shortTag} ${st.doneCount}/${st.validCount}</span>
          </div>
        `;
      }).join("");

      strip.querySelectorAll(".day-pill").forEach(el => {
        el.addEventListener("click", () => {
          selectedDate = el.dataset.date;
          renderScheduleView();
        });
      });
    }

    function renderDaySummary() {
      const box = document.getElementById("daySummaryCard");
      const allDays = getAllDaysMeta();
      if (allDays.length === 0) {
        box.innerHTML = `<div style="text-align:center; padding:12px; color:#64748b;">⏳ 正在從 Google 試算表讀取最新課表...</div>`;
        return;
      }
      const meta = allDays.find(d => d.date === selectedDate) || allDays[0];
      const st = getDayStats(meta.date);

      let cardioText = "今日無有氧（未做不扣分）";
      if (st.sportMin > 0 || st.sportAvgHr > 0 || st.sportKcal > 0 || st.sportLoad > 0) {
        const parts = [`${st.sportMin} 分`];
        if (st.sportAvgHr > 0) parts.push(`均心率 ${st.sportAvgHr}`);
        if (st.sportLoad > 0) parts.push(`負荷 ${st.sportLoad}`);
        if (st.sportKcal > 0) parts.push(`${st.sportKcal} kcal`);
        cardioText = parts.join("｜");
      } else if (st.cardioDone || st.cardioKm > 0 || st.cardioMin > 0) {
        const cParts = [];
        if (st.cardioKm > 0) cParts.push(`${st.cardioKm} km`);
        if (st.cardioMin > 0) cParts.push(`${st.cardioMin} 分`);
        if (st.cardioSpeed > 0) cParts.push(`均速 ${st.cardioSpeed}`);
        if (st.cardioIncline > 0) cParts.push(`坡度 ${st.cardioIncline}%`);
        cardioText = cParts.length > 0 ? cParts.join("｜") : "已完成有氧活動";
      }

      box.innerHTML = `
        <div class="day-module-title">
          <span>${meta.date}（${meta.weekday}）${meta.module}</span>
          <span class="completion-pill">完成度 ${st.doneCount} / ${st.validCount}（${st.rate}%）</span>
        </div>
        <div class="track-mini-grid">
          <div class="mini-box walk">
            <span class="lbl">🚶 日常步行（NEAT）</span>
            <span class="val">${st.walkKm} km｜${st.walkMin} 分（${st.walkSpeed} km/h）</span>
          </div>
          <div class="mini-box strength">
            <span class="lbl">🏋️ 重訓總容量</span>
            <span class="val">${st.totalVol.toLocaleString()} kg</span>
          </div>
          <div class="mini-box cardio">
            <span class="lbl">⌚ 有氧與專項運動</span>
            <span class="val">${cardioText}</span>
          </div>
        </div>
      `;
    }

    function statusClass(status) {
      if (status === "✅ 已完成") return "done";
      if (status === "⏭️ 略過/調整") return "skip";
      if (status === "➖ 今日無有氧") return "none";
      return "";
    }

    function buildPrevRecordHtml(it, isDone) {
      const prev = findPreviousCompletedRecord(it);
      if (!prev) return "";
      const pm = calcStrengthMetrics(prev);
      const isBw = prev.basis === "自重 / 彈力帶" || prev.basis === "時間 / 距離";
      let summaryText = "";
      if (isBw) {
        summaryText = `${prev.actualSets || "-"} 組 × ${prev.actualReps || "-"} 下`;
      } else {
        const wDesc = prev.addedWeight !== "" ? `${prev.addedWeight} ${prev.unit}` : "0";
        const baseDesc = Number(prev.baseKg) > 0 ? `（空槓 ${prev.baseKg}kg）` : "";
        summaryText = `${wDesc}${baseDesc}｜${prev.actualSets || "-"} 組 × ${prev.actualReps || "-"} 下｜有效 ${pm.effectiveKg} kg（總量 ${pm.volumeKg.toLocaleString()} kg）`;
      }
      const copyBtn = (!isDone && !isBw)
        ? `<button type="button" class="btn btn-outline btn-sm" data-action="applyPrev" data-previd="${prev.id}">帶入上次重量</button>`
        : "";
      return `
        <div class="prev-record-bar">
          <span>🕒 上次紀錄（${prev.date.slice(5)} ${prev.weekday}）：${summaryText}</span>
          ${copyBtn}
        </div>
      `;
    }

    function buildCorosFieldsHtml(it, isDone, stripClass) {
      const minVal = parseFloat(it.sportMin) || 0;
      const hrVal = parseFloat(it.sportAvgHr) || 0;
      const kcalVal = parseFloat(it.sportKcal) || 0;
      const loadVal = parseFloat(it.sportLoad) || 0;
      const aeroVal = it.sportAerobicTe !== "" ? it.sportAerobicTe : "-";
      const anaeroVal = it.sportAnaerobicTe !== "" ? it.sportAnaerobicTe : "-";

      return `
        <div class="input-grid-3">
          <div class="field-group">
            <label>運動時間 (分鐘)</label>
            <input type="number" step="1" min="0" class="ctrl-input" data-field="sportMin" value="${it.sportMin}" placeholder="例：60" ${isDone ? "disabled" : ""} />
          </div>
          <div class="field-group">
            <label>平均心率 (bpm)</label>
            <input type="number" step="1" min="0" class="ctrl-input" data-field="sportAvgHr" value="${it.sportAvgHr}" placeholder="例：142" ${isDone ? "disabled" : ""} />
          </div>
          <div class="field-group">
            <label>卡路里 (kcal)</label>
            <input type="number" step="1" min="0" class="ctrl-input" data-field="sportKcal" value="${it.sportKcal}" placeholder="例：742" ${isDone ? "disabled" : ""} />
          </div>
          <div class="field-group">
            <label>訓練負荷 (TL)</label>
            <input type="number" step="1" min="0" class="ctrl-input" data-field="sportLoad" value="${it.sportLoad}" placeholder="例：117" ${isDone ? "disabled" : ""} />
          </div>
          <div class="field-group">
            <label>有氧效果 (TE)</label>
            <input type="number" step="0.1" min="0" max="5" class="ctrl-input" data-field="sportAerobicTe" value="${it.sportAerobicTe}" placeholder="例：3.1" ${isDone ? "disabled" : ""} />
          </div>
          <div class="field-group">
            <label>無氧效果 (TE)</label>
            <input type="number" step="0.1" min="0" max="5" class="ctrl-input" data-field="sportAnaerobicTe" value="${it.sportAnaerobicTe}" placeholder="例：0.9" ${isDone ? "disabled" : ""} />
          </div>
        </div>
        <div class="field-group" style="margin-top:8px;">
          <label>課程內容與備註（選填）</label>
          <input type="text" class="ctrl-input" data-field="sportNotes" value="${escapeHtml(it.sportNotes)}" placeholder="選填：當日課程內容或身體感受" ${isDone ? "disabled" : ""} />
        </div>
        <div class="calc-strip ${stripClass}">
          <span>${minVal} 分｜均心率 ${hrVal || "-"} bpm｜${kcalVal || "-"} kcal</span>
          <span>負荷 ${loadVal || "-"}｜有氧 ${aeroVal} / 無氧 ${anaeroVal}</span>
        </div>
      `;
    }

    function renderScheduleView() {
      renderDayStrip();
      renderDaySummary();

      const container = document.getElementById("scheduleContainer");
      if (!selectedDate) {
        container.innerHTML = "";
        return;
      }

      const dayItems = items.filter(x => x.date === selectedDate);
      const walkItems = dayItems.filter(x => x.rowType === "walk");
      const strengthItems = dayItems.filter(x => x.rowType === "strength");
      const customItems = dayItems.filter(x => x.rowType === "custom");
      const sportItems = dayItems.filter(x => x.rowType === "sport");
      const cardioItems = dayItems.filter(x => x.rowType === "cardio");

      let html = "";

      // 1. 日常步行（NEAT）
      if (walkItems.length > 0) {
        html += `<div class="section-hdr walk-hdr"><span>🚶 1. 日常步行（NEAT）</span><span>獨立累計・不混入重訓</span></div>`;
        walkItems.forEach(it => {
          const isDone = it.status === "✅ 已完成";
          const speed = calcWalkSpeed(it);
          const speedWarn = walkSpeedWarning(it, speed);
          html += `
            <div class="ex-card walk-card ${isDone ? "status-done" : it.status === "⏭️ 略過/調整" ? "status-skip" : ""}" data-id="${it.id}">
              <div class="card-top-row">
                <div>
                  <span class="phase-badge walk">${it.phase}</span>${isDone ? '<span class="lock-badge">🔒 已鎖定</span>' : ""}
                  <h3 class="ex-name">${it.name}</h3>
                </div>
                <select class="status-select ${statusClass(it.status)}" data-field="status">
                  <option value="⬜ 待完成" ${it.status === "⬜ 待完成" ? "selected" : ""}>⬜ 待完成</option>
                  <option value="✅ 已完成" ${it.status === "✅ 已完成" ? "selected" : ""}>✅ 已完成</option>
                  <option value="⏭️ 略過/調整" ${it.status === "⏭️ 略過/調整" ? "selected" : ""}>⏭️ 略過/調整</option>
                </select>
              </div>
              <div class="meta-chips">
                <span class="meta-chip">目標：${it.targetReps}</span>
                <span class="meta-chip">建議：${it.rpe}</span>
              </div>
              <div class="cue-box">${it.cues}</div>
              <div class="input-grid">
                <div class="field-group">
                  <label>散步距離 (km)</label>
                  <input type="number" step="0.01" min="0" class="ctrl-input" data-field="walkKm" value="${it.walkKm}" placeholder="例：3.2" ${isDone ? "disabled" : ""} />
                </div>
                <div class="field-group">
                  <label>散步時長 (分鐘)</label>
                  <input type="number" step="1" min="0" class="ctrl-input" data-field="walkMin" value="${it.walkMin}" placeholder="例：40" ${isDone ? "disabled" : ""} />
                </div>
              </div>
              <div class="calc-strip walk-calc">
                <span>自動換算平均時速</span>
                <span>${speed} km/h</span>
              </div>
              <div class="warn-banner" data-walk-warning ${speedWarn ? "" : "hidden"}>${speedWarn}</div>
            </div>
          `;
        });
      }

      // 2. 重訓課表（含熱身與自訂替代動作，全部直接展開）
      if (strengthItems.length > 0 || customItems.length > 0) {
        html += `<div class="section-hdr strength-hdr"><span>🏋️ 2. 重訓課表（含熱身與自訂替代動作）</span><span>自動對照上次紀錄</span></div>`;

        strengthItems.forEach(it => {
          const isDone = it.status === "✅ 已完成";
          const m = calcStrengthMetrics(it);
          const isBodyweight = it.basis === "自重 / 彈力帶" || it.basis === "時間 / 距離";
          const measurement = strengthMeasurement(it);
          const video = getExerciseVideo(it);
          const ytHtml = video
            ? `<a href="${video}" target="_blank" rel="noopener noreferrer" class="yt-btn">▶ 觀看動作示範短片</a>`
            : "";
          const prevHtml = buildPrevRecordHtml(it, isDone);

          html += `
            <div class="ex-card ${isDone ? "status-done" : it.status === "⏭️ 略過/調整" ? "status-skip" : ""}" data-id="${it.id}">
              <div class="card-top-row">
                <div>
                  <span class="phase-badge">${it.phase}</span>${isDone ? '<span class="lock-badge">🔒 已鎖定</span>' : ""}
                  <h3 class="ex-name">${it.name}</h3>
                </div>
                <select class="status-select ${statusClass(it.status)}" data-field="status">
                  <option value="⬜ 待完成" ${it.status === "⬜ 待完成" ? "selected" : ""}>⬜ 待完成</option>
                  <option value="✅ 已完成" ${it.status === "✅ 已完成" ? "selected" : ""}>✅ 已完成</option>
                  <option value="⏭️ 略過/調整" ${it.status === "⏭️ 略過/調整" ? "selected" : ""}>⏭️ 略過/調整</option>
                </select>
              </div>
              ${prevHtml}
              <div class="meta-chips">
                <span class="meta-chip">目標：${it.targetSets} 組 × ${it.targetReps}</span>
                <span class="meta-chip">組間休息：${it.rest}</span>
                <span class="meta-chip">${it.rpe}</span>
              </div>
              <div class="cue-box">
                <div><strong>力學與操作要點：</strong>${it.cues}</div>
                <div style="margin-top:4px;"><strong>目標部位：</strong>${it.muscles}</div>
                ${ytHtml}
              </div>
              <div class="input-grid">
                <div class="field-group">
                  <label>計量基準</label>
                  <select class="ctrl-select" data-field="basis" ${isDone ? "disabled" : ""}>
                    <option value="總重 (含槓/機重)" ${it.basis === "總重 (含槓/機重)" ? "selected" : ""}>總重 (含槓/機重)</option>
                    <option value="單邊計重 (×2)" ${it.basis === "單邊計重 (×2)" ? "selected" : ""}>單邊計重 (×2)</option>
                    <option value="單支啞鈴 (×2)" ${it.basis === "單支啞鈴 (×2)" ? "selected" : ""}>單支啞鈴 (×2)</option>
                    <option value="自重 / 彈力帶" ${it.basis === "自重 / 彈力帶" ? "selected" : ""}>自重 / 彈力帶</option>
                    <option value="時間 / 距離" ${it.basis === "時間 / 距離" ? "selected" : ""}>時間 / 距離</option>
                  </select>
                </div>
                <div class="field-group">
                  <label>空槓/機台重 (kg)</label>
                  <input type="number" step="0.5" min="0" class="ctrl-input" data-field="baseKg" value="${it.baseKg}" ${isBodyweight || isDone ? "disabled" : ""} />
                </div>
                <div class="field-group">
                  <label>外加/手持重量</label>
                  <div class="weight-unit-row">
                    <input type="number" step="0.5" min="0" class="ctrl-input" data-field="addedWeight" value="${it.addedWeight}" placeholder="${isBodyweight ? "自重/距離" : "空槓填0"}" ${isBodyweight || isDone ? "disabled" : ""} />
                    <button type="button" class="unit-btn ${it.unit === "LB" ? "lb" : ""}" data-action="toggleUnit" ${isBodyweight || isDone ? "disabled" : ""}>${it.unit}</button>
                  </div>
                </div>
                <div class="field-group">
                  <label>實際組數</label>
                  <input type="number" step="1" min="0" class="ctrl-input" data-field="actualSets" value="${it.actualSets}" placeholder="${it.targetSets || 3}" ${isDone ? "disabled" : ""} />
                </div>
                <div class="field-group">
                  <label>${measurement?.label || "實際次數 (單組)"}</label>
                  <input type="number" step="${measurement?.step || 1}" min="0" class="ctrl-input" data-field="actualReps" value="${it.actualReps}" placeholder="${measurement?.amount || 10}" ${isDone ? "disabled" : ""} />
                </div>
              </div>
              <div class="calc-strip" ${measurement ? 'style="display:none;"' : ""}>
                <span>單組有效總重：${m.effectiveKg} kg</span>
                <span>總訓練容量 Volume：${m.volumeKg.toLocaleString()} kg</span>
              </div>
            </div>
          `;
        });

        customItems.forEach((it, idx) => {
          const isDone = it.status === "✅ 已完成";
          const m = calcStrengthMetrics(it);
          const isBodyweight = it.basis === "自重 / 彈力帶";
          const prevHtml = buildPrevRecordHtml(it, isDone);

          html += `
            <div class="ex-card custom-card ${isDone ? "status-done" : it.status === "⏭️ 略過/調整" ? "status-skip" : ""}" data-id="${it.id}">
              <div class="card-top-row">
                <div style="flex:1;">
                  <span class="phase-badge custom">${it.phase || ("自訂加練 / 替代 " + (idx + 1))}</span>${isDone ? '<span class="lock-badge">🔒 已鎖定</span>' : ""}
                  <input type="text" class="ctrl-input" data-field="name" value="${escapeHtml(it.name)}" placeholder="選填：輸入自訂加練或臨時替代動作（留白不計分）" style="margin-top:4px; font-weight:700;" ${isDone ? "disabled" : ""} />
                </div>
                <div style="display:flex; flex-direction:column; gap:5px; align-items:flex-end;">
                  <select class="status-select ${statusClass(it.status)}" data-field="status">
                    <option value="⬜ 待完成" ${it.status === "⬜ 待完成" ? "selected" : ""}>⬜ 待完成</option>
                    <option value="✅ 已完成" ${it.status === "✅ 已完成" ? "selected" : ""}>✅ 已完成</option>
                    <option value="⏭️ 略過/調整" ${it.status === "⏭️ 略過/調整" ? "selected" : ""}>⏭️ 略過/調整</option>
                  </select>
                  <button type="button" class="btn btn-outline btn-sm" data-action="clearCustom" ${isDone ? "disabled" : ""}>清空此格</button>
                </div>
              </div>
              ${prevHtml}
              <div class="field-group" style="margin-bottom:8px;">
                <label>個人筆記 / 座椅設定</label>
                <input type="text" class="ctrl-input" data-field="cues" value="${escapeHtml(it.cues)}" placeholder="選填：椅墊高度、發力感受或替代原因" ${isDone ? "disabled" : ""} />
              </div>
              <div class="input-grid">
                <div class="field-group">
                  <label>計量基準</label>
                  <select class="ctrl-select" data-field="basis" ${isDone ? "disabled" : ""}>
                    <option value="總重 (含槓/機重)" ${it.basis === "總重 (含槓/機重)" ? "selected" : ""}>總重 (含槓/機重)</option>
                    <option value="單邊計重 (×2)" ${it.basis === "單邊計重 (×2)" ? "selected" : ""}>單邊計重 (×2)</option>
                    <option value="單支啞鈴 (×2)" ${it.basis === "單支啞鈴 (×2)" ? "selected" : ""}>單支啞鈴 (×2)</option>
                    <option value="自重 / 彈力帶" ${it.basis === "自重 / 彈力帶" ? "selected" : ""}>自重 / 彈力帶</option>
                  </select>
                </div>
                <div class="field-group">
                  <label>空槓/機台重 (kg)</label>
                  <input type="number" step="0.5" min="0" class="ctrl-input" data-field="baseKg" value="${it.baseKg}" ${isBodyweight || isDone ? "disabled" : ""} />
                </div>
                <div class="field-group">
                  <label>外加/手持重量</label>
                  <div class="weight-unit-row">
                    <input type="number" step="0.5" min="0" class="ctrl-input" data-field="addedWeight" value="${it.addedWeight}" placeholder="重量" ${isBodyweight || isDone ? "disabled" : ""} />
                    <button type="button" class="unit-btn ${it.unit === "LB" ? "lb" : ""}" data-action="toggleUnit" ${isBodyweight || isDone ? "disabled" : ""}>${it.unit}</button>
                  </div>
                </div>
                <div class="field-group">
                  <label>實際組數</label>
                  <input type="number" step="1" min="0" class="ctrl-input" data-field="actualSets" value="${it.actualSets}" placeholder="3" ${isDone ? "disabled" : ""} />
                </div>
                <div class="field-group">
                  <label>實際次數 (單組)</label>
                  <input type="number" step="1" min="0" class="ctrl-input" data-field="actualReps" value="${it.actualReps}" placeholder="12" ${isDone ? "disabled" : ""} />
                </div>
              </div>
              <div class="calc-strip">
                <span>單組有效總重：${m.effectiveKg} kg</span>
                <span>總訓練容量 Volume：${m.volumeKg.toLocaleString()} kg</span>
              </div>
            </div>
          `;
        });
      }

      // 3. 有氧活動與專項運動（全部直接展開，統一 COROS 數據模式）
      if (sportItems.length > 0 || cardioItems.length > 0) {
        html += `<div class="section-hdr cardio-hdr"><span>⌚ 3. 有氧活動與專項運動（COROS 數據）</span><span>未做不扣分・填完再選已完成</span></div>`;

        sportItems.forEach(it => {
          const isDone = it.status === "✅ 已完成";
          const video = getExerciseVideo(it);
          const ytHtml = video
            ? `<a href="${video}" target="_blank" rel="noopener noreferrer" class="yt-btn">▶ 觀看動作與熱身參考</a>`
            : "";

          html += `
            <div class="ex-card sport-card ${isDone ? "status-done" : it.status === "⏭️ 略過/調整" ? "status-skip" : ""}" data-id="${it.id}">
              <div class="card-top-row">
                <div style="flex:1;">
                  <span class="phase-badge sport">當日主排專項運動</span>${isDone ? '<span class="lock-badge">🔒 已鎖定</span>' : ""}
                  <input type="text" class="ctrl-input" data-field="name" value="${escapeHtml(it.name)}" style="margin-top:4px; font-weight:700;" ${isDone ? "disabled" : ""} />
                </div>
                <select class="status-select ${statusClass(it.status)}" data-field="status">
                  <option value="⬜ 待完成" ${it.status === "⬜ 待完成" ? "selected" : ""}>⬜ 待完成</option>
                  <option value="✅ 已完成" ${it.status === "✅ 已完成" ? "selected" : ""}>✅ 已完成</option>
                  <option value="⏭️ 略過/調整" ${it.status === "⏭️ 略過/調整" ? "selected" : ""}>⏭️ 略過/調整</option>
                </select>
              </div>
              <div class="cue-box">
                <div><strong>紀錄方式：</strong>${it.cues}</div>
                <div style="margin-top:4px;"><strong>訓練效益：</strong>${it.muscles}</div>
                ${ytHtml}
              </div>
              ${buildCorosFieldsHtml(it, isDone, "sport-calc")}
            </div>
          `;
        });

        const dynamicOptions = getDynamicCardioOptions();
        cardioItems.forEach((it, idx) => {
          const isDone = it.status === "✅ 已完成";
          const currentName = String(it.name || "").trim();
          const optionsHtml = [
            `<option value="" ${currentName === "" ? "selected" : ""}>— 請選擇有氧活動（留白不計分）—</option>`,
            ...dynamicOptions.map(opt => `<option value="${escapeHtml(opt)}" ${currentName === opt ? "selected" : ""}>${escapeHtml(opt)}</option>`),
            `<option value="__CUSTOM__">✏️ 自行輸入其他項目...</option>`
          ].join("");

          html += `
            <div class="ex-card cardio-card ${isDone ? "status-done" : it.status === "⏭️ 略過/調整" ? "status-skip" : ""}" data-id="${it.id}">
              <div class="card-top-row">
                <div style="flex:1;">
                  <span class="phase-badge cardio">有氧活動 (選填) ${idx + 1}</span>${isDone ? '<span class="lock-badge">🔒 已鎖定</span>' : ""}
                  <select class="ctrl-select" data-field="name" style="margin-top:4px; font-weight:700;" ${isDone ? "disabled" : ""}>
                    ${optionsHtml}
                  </select>
                </div>
                <div style="display:flex; flex-direction:column; gap:5px; align-items:flex-end;">
                  <select class="status-select ${statusClass(it.status)}" data-field="status">
                    <option value="➖ 今日無有氧" ${it.status === "➖ 今日無有氧" ? "selected" : ""}>➖ 今日無有氧</option>
                    <option value="⬜ 待完成" ${it.status === "⬜ 待完成" ? "selected" : ""}>⬜ 待完成</option>
                    <option value="✅ 已完成" ${it.status === "✅ 已完成" ? "selected" : ""}>✅ 已完成</option>
                    <option value="⏭️ 略過/調整" ${it.status === "⏭️ 略過/調整" ? "selected" : ""}>⏭️ 略過/調整</option>
                  </select>
                  <button type="button" class="btn btn-outline btn-sm" data-action="clearCardio" ${isDone ? "disabled" : ""}>清空重設</button>
                </div>
              </div>
              <div class="cue-box">
                <div><strong>紀錄方式：</strong>${it.cues || "均心率 -- bpm / 卡路里 -- kcal / 訓練負荷 -- / 有氧效果 -- / 無氧效果 --"}</div>
              </div>
              ${buildCorosFieldsHtml(it, isDone, "cardio-calc")}
            </div>
          `;
        });
      }

      container.innerHTML = html;
      bindScheduleEvents();
    }

    function bindScheduleEvents() {
      const container = document.getElementById("scheduleContainer");

      container.querySelectorAll("[data-field]").forEach(el => {
        const handler = (e) => {
          const card = e.target.closest(".ex-card");
          const id = card.dataset.id;
          const item = items.find(x => x.id === id);
          if (!item) return;
          const field = e.target.dataset.field;
          let newVal = e.target.value;

          if (item.rowType === "cardio" && field === "name" && newVal === "__CUSTOM__") {
            const customInput = prompt("請輸入自訂有氧活動名稱：");
            if (customInput && customInput.trim()) {
              newVal = customInput.trim();
            } else {
              e.target.value = item.name || "";
              return;
            }
          }

          const previousRow = build28ColRows([item])[1];
          item[field] = newVal;

          // 選了項目名稱後，若原本為「➖ 今日無有氧」則自動切換為「⬜ 待完成」（不自動完成鎖定）
          if (item.rowType === "cardio" && field === "name") {
            if (String(item.name || "").trim() !== "" && item.status === "➖ 今日無有氧") {
              item.status = "⬜ 待完成";
            }
          }

          if (field === "status" && item.status === "✅ 已完成" && item.rowType === "strength") {
            if (String(item.actualSets || "").trim() === "" && Number(item.targetSets) > 0) {
              item.actualSets = String(item.targetSets);
            }
          }

          queueWorkoutEdit(item, previousRow);
          saveState();
          if (field === "basis" || field === "status" || (item.rowType === "cardio" && field === "name")) {
            renderScheduleView();
          } else {
            updateCardLiveDisplay(card, item);
            renderDayStrip();
            renderDaySummary();
          }
        };
        el.addEventListener("input", handler);
        if (el.tagName === "SELECT") {
          el.addEventListener("change", handler);
        }
      });

      container.querySelectorAll('[data-action="applyPrev"]').forEach(btn => {
        btn.addEventListener("click", (e) => {
          const card = e.target.closest(".ex-card");
          const item = items.find(x => x.id === card.dataset.id);
          const prev = items.find(x => x.id === btn.dataset.previd);
          if (!item || !prev) return;
          const previousRow = build28ColRows([item])[1];
          item.basis = prev.basis;
          item.baseKg = prev.baseKg;
          item.addedWeight = prev.addedWeight;
          item.unit = prev.unit;
          queueWorkoutEdit(item, previousRow);
          saveState();
          renderScheduleView();
          showToast(`已帶入 ${prev.date.slice(5)} 重量設定`);
        });
      });

      container.querySelectorAll('[data-action="toggleUnit"]').forEach(btn => {
        btn.addEventListener("click", (e) => {
          const card = e.target.closest(".ex-card");
          const item = items.find(x => x.id === card.dataset.id);
          if (!item) return;
          const previousRow = build28ColRows([item])[1];
          item.unit = item.unit === "KG" ? "LB" : "KG";
          queueWorkoutEdit(item, previousRow);
          saveState();
          renderScheduleView();
        });
      });

      container.querySelectorAll('[data-action="clearCustom"]').forEach(btn => {
        btn.addEventListener("click", (e) => {
          const card = e.target.closest(".ex-card");
          const item = items.find(x => x.id === card.dataset.id);
          if (!item) return;
          const previousRow = build28ColRows([item])[1];
          item.name = "";
          item.cues = "";
          item.basis = "總重 (含槓/機重)";
          item.baseKg = 0;
          item.addedWeight = "";
          item.unit = "KG";
          item.actualSets = "";
          item.actualReps = "";
          item.status = "⬜ 待完成";
          queueWorkoutEdit(item, previousRow);
          saveState();
          renderScheduleView();
          showToast("已清空此自訂槽");
        });
      });

      container.querySelectorAll('[data-action="clearCardio"]').forEach(btn => {
        btn.addEventListener("click", (e) => {
          const card = e.target.closest(".ex-card");
          const item = items.find(x => x.id === card.dataset.id);
          if (!item) return;
          const previousRow = build28ColRows([item])[1];
          item.name = "";
          item.sportMin = "";
          item.sportAvgHr = "";
          item.sportKcal = "";
          item.sportLoad = "";
          item.sportAerobicTe = "";
          item.sportAnaerobicTe = "";
          item.sportNotes = "";
          item.cardioKm = "";
          item.cardioMin = "";
          item.cardioSpeed = "";
          item.cardioIncline = "";
          item.status = "➖ 今日無有氧";
          queueWorkoutEdit(item, previousRow);
          saveState();
          renderScheduleView();
          showToast("已重設本機有氧欄位，雲端已填資料會保留");
        });
      });
    }

    function updateCardLiveDisplay(card, item) {
      if (item.rowType === "walk") {
        const speed = calcWalkSpeed(item);
        const strip = card.querySelector(".calc-strip");
        if (strip) strip.innerHTML = `<span>自動換算平均時速</span><span>${speed} km/h</span>`;
        const warning = card.querySelector("[data-walk-warning]");
        if (warning) {
          warning.textContent = walkSpeedWarning(item, speed);
          warning.hidden = !warning.textContent;
        }
      } else if (item.rowType === "sport" || item.rowType === "cardio") {
        const minVal = parseFloat(item.sportMin) || 0;
        const hrVal = parseFloat(item.sportAvgHr) || 0;
        const kcalVal = parseFloat(item.sportKcal) || 0;
        const loadVal = parseFloat(item.sportLoad) || 0;
        const aeroVal = item.sportAerobicTe !== "" ? item.sportAerobicTe : "-";
        const anaeroVal = item.sportAnaerobicTe !== "" ? item.sportAnaerobicTe : "-";
        const strip = card.querySelector(".calc-strip");
        if (strip) {
          strip.innerHTML = `<span>${minVal} 分｜均心率 ${hrVal || "-"} bpm｜${kcalVal || "-"} kcal</span><span>負荷 ${loadVal || "-"}｜有氧 ${aeroVal} / 無氧 ${anaeroVal}</span>`;
        }
      } else {
        const m = calcStrengthMetrics(item);
        const strip = card.querySelector(".calc-strip");
        if (strip) strip.innerHTML = `<span>單組有效總重：${m.effectiveKg} kg</span><span>總訓練容量 Volume：${m.volumeKg.toLocaleString()} kg</span>`;
      }
    }

    function renderStarSelector() {
      const row = document.getElementById("mStarRow");
      row.innerHTML = [1, 2, 3, 4, 5].map(n => `
        <button type="button" class="star-btn ${n <= currentFormRating ? "active" : ""}" data-star="${n}">★</button>
      `).join("");
      row.querySelectorAll(".star-btn").forEach(btn => {
        btn.addEventListener("click", () => {
          currentFormRating = parseInt(btn.dataset.star, 10);
          renderStarSelector();
        });
      });
    }

    function compressImageFile(file) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = (ev) => {
          const img = new Image();
          img.onload = () => {
            const scale = Math.min(1, 900 / Math.max(img.width, img.height));
            const w = Math.max(1, Math.round(img.width * scale));
            const h = Math.max(1, Math.round(img.height * scale));
            const canvas = document.createElement("canvas");
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL("image/jpeg", 0.72));
          };
          img.onerror = reject;
          img.src = ev.target.result;
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    }

    function resetMachineForm() {
      editingMachineId = null;
      document.getElementById("machineFormTitle").textContent = "📸 新增感受良好的健身房器械（拍照登錄供日後排課）";
      document.getElementById("mName").value = "";
      document.getElementById("mSetup").value = "";
      document.getElementById("mNotes").value = "";
      document.getElementById("mPhotoInput").value = "";
      currentFormRating = 5;
      currentFormPhoto = "";
      formPhotoChanged = false;
      document.getElementById("mPhotoPreviewWrap").style.display = "none";
      document.getElementById("mCancelEditBtn").style.display = "none";
      renderStarSelector();
    }

    function renderMachineLibrary() {
      const cats = Array.from(new Set(["拉日（背/二頭）", "腿日（股四頭/臀腿）", "推日（胸/肩/三頭）", "有氧與功能器械", ...machines.map(m => m.category).filter(Boolean)]));
      const filters = ["ALL", ...cats];
      const filterRow = document.getElementById("machineFilterRow");
      filterRow.innerHTML = filters.map(f => `
        <button type="button" class="preset-pill" style="${selectedMachineFilter === f ? "background:#1e293b;color:#fff;border-color:#1e293b;" : "color:#334155;border-color:#cbd5e1;"}" data-mfilter="${escapeHtml(f)}">
          ${f === "ALL" ? "全部收藏 (" + machines.length + ")" : escapeHtml(f)}
        </button>
      `).join("");

      filterRow.querySelectorAll("[data-mfilter]").forEach(btn => {
        btn.addEventListener("click", () => {
          selectedMachineFilter = btn.dataset.mfilter;
          renderMachineLibrary();
        });
      });

      const list = selectedMachineFilter === "ALL" ? machines : machines.filter(m => m.category === selectedMachineFilter);
      const container = document.getElementById("machineListContainer");

      if (list.length === 0) {
        container.innerHTML = `<div class="panel-card" style="grid-column:1/-1; text-align:center; color:#64748b;">尚無符合條件的收藏器械。在健身房練到發力感好的機器時，可隨時拍照並登錄於上方表單。</div>`;
        return;
      }

      container.innerHTML = list.map(m => {
        const stars = "★".repeat(m.rating || 5) + "☆".repeat(5 - (m.rating || 5));
        const photo = machinePhotoSource(m);
        const imgHtml = photo
          ? `<img src="${escapeHtml(photo)}" alt="${escapeHtml(m.name)}" class="machine-thumb" data-zoom="${escapeHtml(m.id)}" loading="lazy" />`
          : `<div class="machine-thumb" style="display:flex;align-items:center;justify-content:center;color:#94a3b8;font-size:0.85rem;cursor:default;">未附照片</div>`;
        return `
          <div class="machine-item">
            ${imgHtml}
            <div class="machine-body">
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <span class="phase-badge">${escapeHtml(m.category)}</span>
                <span style="color:#f59e0b; font-weight:700; font-size:0.9rem;">${stars}</span>
              </div>
              <h3 class="ex-name" style="font-size:0.96rem;">${escapeHtml(m.name)}</h3>
              ${m.setup ? `<div style="font-size:0.78rem; color:#0f766e; font-weight:700;">設定：${escapeHtml(m.setup)}</div>` : ""}
              ${m.notes ? `<div style="font-size:0.8rem; color:#475569;">${escapeHtml(m.notes)}</div>` : ""}
              <div style="margin-top:auto; padding-top:8px; display:flex; justify-content:space-between; align-items:center; border-top:1px solid #f1f5f9;">
                <span style="font-size:0.72rem; color:#94a3b8;">${m.date || ""}</span>
                <div style="display:flex; gap:6px;">
                  <button type="button" class="btn btn-outline btn-sm" data-medit="${m.id}">編輯</button>
                  <button type="button" class="btn btn-danger btn-sm" data-mdel="${m.id}">刪除</button>
                </div>
              </div>
            </div>
          </div>
        `;
      }).join("");

      container.querySelectorAll("[data-zoom]").forEach(img => {
        img.addEventListener("click", () => {
          const m = machines.find(x => x.id === img.dataset.zoom);
          const photo = m && machinePhotoSource(m);
          if (photo) {
            document.getElementById("modalImgEl").src = photo;
            document.getElementById("imgModal").classList.add("open");
          }
        });
      });

      container.querySelectorAll("[data-medit]").forEach(btn => {
        btn.addEventListener("click", () => {
          const m = machines.find(x => x.id === btn.dataset.medit);
          if (!m) return;
          editingMachineId = m.id;
          document.getElementById("machineFormTitle").textContent = "✏️ 編輯器械紀錄";
          document.getElementById("mName").value = m.name;
          document.getElementById("mCategory").value = m.category;
          document.getElementById("mSetup").value = m.setup || "";
          document.getElementById("mNotes").value = m.notes || "";
          currentFormRating = m.rating || 5;
          currentFormPhoto = m.photo || "";
          formPhotoChanged = false;
          const photo = machinePhotoSource(m);
          if (photo) {
            document.getElementById("mPhotoPreview").src = photo;
            document.getElementById("mPhotoPreviewWrap").style.display = "flex";
          } else {
            document.getElementById("mPhotoPreviewWrap").style.display = "none";
          }
          document.getElementById("mCancelEditBtn").style.display = "inline-flex";
          renderStarSelector();
          window.scrollTo({ top: 0, behavior: "smooth" });
        });
      });

      container.querySelectorAll("[data-mdel]").forEach(btn => {
        btn.addEventListener("click", () => {
          const id = btn.dataset.mdel;
          queueMachineEdit({ id, deleted: true });
          machines = machines.filter(x => x.id !== id);
          saveState();
          queuePhotoChange(id, true);
          renderMachineLibrary();
          showToast("已刪除器械紀錄");
        });
      });
    }

    function renderOverviewView() {
      renderWeekSwitcher("overviewWeekSwitcherBar", renderOverviewView);
      const weeks = getWeeksList();
      if (weeks.length === 0) return;

      const currentWeek = weeks[selectedWeekIdx] || { fullRange: "", days: [] };
      document.getElementById("overviewTableTitle").textContent = `當週訓練數據彙總表（${currentWeek.fullRange}）`;

      const statsByDay = currentWeek.days.map(d => ({ ...d, ...getDayStats(d.date) }));
      const totValid = statsByDay.reduce((s, x) => s + x.validCount, 0);
      const totDone = statsByDay.reduce((s, x) => s + x.doneCount, 0);
      const totRate = totValid > 0 ? Math.round((totDone / totValid) * 100) : 0;
      const totVol = Math.round(statsByDay.reduce((s, x) => s + x.totalVol, 0) * 10) / 10;
      const totWalkKm = Math.round(statsByDay.reduce((s, x) => s + x.walkKm, 0) * 100) / 100;
      const totWalkMin = statsByDay.reduce((s, x) => s + x.walkMin, 0);
      const avgWalkSpeed = totWalkMin > 0 ? Math.round((totWalkKm / (totWalkMin / 60)) * 100) / 100 : 0;
      const totCardioKm = Math.round(statsByDay.reduce((s, x) => s + x.cardioKm, 0) * 100) / 100;
      const totCardioMin = statsByDay.reduce((s, x) => s + x.cardioMin + x.sportMin, 0);
      const totSportKcal = statsByDay.reduce((s, x) => s + x.sportKcal, 0);
      const totSportLoad = statsByDay.reduce((s, x) => s + x.sportLoad, 0);

      document.getElementById("overviewKpiGrid").innerHTML = `
        <div class="kpi-card">
          <div class="k-title">當週有效任務完成率</div>
          <div class="k-val">${totRate}%</div>
          <div class="k-sub">已完成 ${totDone} / ${totValid} 項（空白槽與無有氧不扣分）</div>
        </div>
        <div class="kpi-card">
          <div class="k-title">當週重訓總容量 Volume</div>
          <div class="k-val" style="color:#0f766e;">${totVol.toLocaleString()} kg</div>
          <div class="k-sub">含單邊(×2)、單支啞鈴(×2)與 LB 自動換算</div>
        </div>
        <div class="kpi-card">
          <div class="k-title">當週日常步行 NEAT 累計</div>
          <div class="k-val" style="color:#0369a1;">${totWalkKm} km</div>
          <div class="k-sub">總時長 ${totWalkMin} 分｜均速 ${avgWalkSpeed} km/h</div>
        </div>
        <div class="kpi-card">
          <div class="k-title">當週有氧與專項運動累計</div>
          <div class="k-val" style="color:#be123c;">${totCardioMin} 分</div>
          <div class="k-sub">${totCardioKm > 0 ? "有氧 " + totCardioKm + " km｜" : ""}負荷 ${totSportLoad}｜${totSportKcal} kcal</div>
        </div>
      `;

      const weekSummaries = weeks.map(w => {
        const dStats = w.days.map(d => getDayStats(d.date));
        const wVol = Math.round(dStats.reduce((s, x) => s + x.totalVol, 0) * 10) / 10;
        const wWalk = Math.round(dStats.reduce((s, x) => s + x.walkKm, 0) * 100) / 100;
        const wMin = dStats.reduce((s, x) => s + x.cardioMin + x.sportMin, 0);
        return { label: `第${w.index + 1}週 (${w.label})`, wVol, wWalk, wMin };
      });
      const maxWeekVol = Math.max(1, ...weekSummaries.map(x => x.wVol));
      document.getElementById("chartCrossWeek").innerHTML = weekSummaries.map(ws => `
        <div class="bar-row" style="grid-template-columns: 140px 1fr 165px;">
          <strong>${ws.label}</strong>
          <div class="bar-track"><div class="bar-fill teal" style="width:${Math.round((ws.wVol / maxWeekVol) * 100)}%"></div></div>
          <span style="text-align:right; font-weight:700; color:#0f766e;">${ws.wVol.toLocaleString()} kg｜${ws.wWalk}km</span>
        </div>
      `).join("");

      const maxVol = Math.max(1, ...statsByDay.map(x => x.totalVol));
      document.getElementById("chartStrength").innerHTML = statsByDay.map(d => `
        <div class="bar-row">
          <strong>${d.weekday} ${d.date.slice(5)}</strong>
          <div class="bar-track"><div class="bar-fill teal" style="width:${Math.round((d.totalVol / maxVol) * 100)}%"></div></div>
          <span style="text-align:right; font-weight:700; color:#0f766e;">${d.totalVol.toLocaleString()} kg</span>
        </div>
      `).join("");

      const maxWalk = Math.max(1, ...statsByDay.map(x => x.walkKm));
      document.getElementById("chartWalk").innerHTML = statsByDay.map(d => `
        <div class="bar-row">
          <strong>${d.weekday} ${d.date.slice(5)}</strong>
          <div class="bar-track"><div class="bar-fill sky" style="width:${Math.round((d.walkKm / maxWalk) * 100)}%"></div></div>
          <span style="text-align:right; font-weight:700; color:#0369a1;">${d.walkKm} km (${d.walkSpeed})</span>
        </div>
      `).join("");

      const maxMin = Math.max(1, ...statsByDay.map(x => x.cardioMin + x.sportMin));
      document.getElementById("chartCardio").innerHTML = statsByDay.map(d => {
        const dayTotMin = d.cardioMin + d.sportMin;
        return `
        <div class="bar-row">
          <strong>${d.weekday} ${d.date.slice(5)}</strong>
          <div class="bar-track"><div class="bar-fill rose" style="width:${Math.round((dayTotMin / maxMin) * 100)}%"></div></div>
          <span style="text-align:right; font-weight:700; color:#be123c;">${dayTotMin} 分${d.sportLoad > 0 ? " (TL " + d.sportLoad + ")" : ""}</span>
        </div>
      `;
      }).join("");

      document.getElementById("overviewTableWrap").innerHTML = `
        <table class="summary-tbl">
          <thead>
            <tr>
              <th>日期</th>
              <th>星期</th>
              <th>課表主題</th>
              <th>完成度</th>
              <th>重訓容量 (kg)</th>
              <th>散步距離 (km)</th>
              <th>散步均速</th>
              <th>有氧與專項紀錄</th>
            </tr>
          </thead>
          <tbody>
            ${statsByDay.map(d => {
              let specCell = "-";
              if (d.sportMin > 0 || d.sportKcal > 0 || d.sportAvgHr > 0 || d.sportLoad > 0) {
                const segs = [`${d.sportMin}分`];
                if (d.sportAvgHr > 0) segs.push(`${d.sportAvgHr}bpm`);
                if (d.sportLoad > 0) segs.push(`TL:${d.sportLoad}`);
                if (d.sportKcal > 0) segs.push(`${d.sportKcal}kcal`);
                specCell = segs.join(" / ");
              } else if (d.cardioMin > 0 || d.cardioKm > 0) {
                specCell = `${d.cardioKm}km / ${d.cardioMin}分 / ${d.cardioIncline}%`;
              }
              return `
              <tr>
                <td>${d.date}</td>
                <td><strong>${d.weekday}</strong></td>
                <td style="text-align:left;">${d.module}</td>
                <td>${d.doneCount}/${d.validCount} (${d.rate}%)</td>
                <td style="font-weight:700; color:#0f766e;">${d.totalVol.toLocaleString()}</td>
                <td style="color:#0369a1;">${d.walkKm}</td>
                <td style="color:#0369a1;">${d.walkSpeed} km/h</td>
                <td style="color:#be123c;">${specCell}</td>
              </tr>
            `;
            }).join("")}
          </tbody>
        </table>
      `;

      renderExerciseHistoryExplorer();
    }

    function renderExerciseHistoryExplorer() {
      const selectEl = document.getElementById("historyExerciseSelect");
      const wrapEl = document.getElementById("historyExerciseWrap");
      if (!selectEl || !wrapEl) return;

      const exerciseNames = Array.from(new Set(
        items
          .filter(x => (x.rowType === "strength" || x.rowType === "custom") && String(x.name || "").trim() !== "" && x.basis !== "自重 / 彈力帶")
          .map(x => String(x.name).trim())
      ));

      if (exerciseNames.length === 0) {
        selectEl.innerHTML = `<option value="">尚無負重動作紀錄</option>`;
        wrapEl.innerHTML = "";
        return;
      }

      const prevSelected = selectEl.value;
      selectEl.innerHTML = exerciseNames.map(n => `<option value="${escapeHtml(n)}" ${n === prevSelected ? "selected" : ""}>${escapeHtml(n)}</option>`).join("");

      const renderHistoryRows = () => {
        const chosen = selectEl.value;
        const logs = items
          .filter(x => String(x.name || "").trim() === chosen)
          .sort((a, b) => b.date.localeCompare(a.date));

        wrapEl.innerHTML = `
          <table class="summary-tbl">
            <thead>
              <tr>
                <th>日期</th>
                <th>狀態</th>
                <th>計量基準</th>
                <th>空槓/機台重</th>
                <th>外加/手持重</th>
                <th>組 × 次</th>
                <th>單組有效總重</th>
                <th>總容量 Volume</th>
              </tr>
            </thead>
            <tbody>
              ${logs.map(l => {
                const m = calcStrengthMetrics(l);
                return `
                  <tr>
                    <td>${l.date}（${l.weekday}）</td>
                    <td>${l.status}</td>
                    <td>${l.basis}</td>
                    <td>${l.baseKg} kg</td>
                    <td>${l.addedWeight !== "" ? l.addedWeight + " " + l.unit : "-"}</td>
                    <td>${l.actualSets || "-"} × ${l.actualReps || "-"}</td>
                    <td style="font-weight:700;">${m.effectiveKg} kg</td>
                    <td style="font-weight:700; color:#0f766e;">${m.volumeKg.toLocaleString()} kg</td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        `;
      };

      selectEl.onchange = renderHistoryRows;
      renderHistoryRows();
    }

    const GAS_CODE_TEMPLATE = `function doGet(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheetSched = ss.getSheetByName("每日詳細訓練課表");
  var sheetMach = ss.getSheetByName("器械感受收藏庫");
  var schedData = sheetSched ? sheetSched.getDataRange().getValues() : [];
  var machData = sheetMach ? sheetMach.getDataRange().getValues() : [];
  return ContentService.createTextOutput(JSON.stringify({
    status: "ok",
    syncVersion: "${SYNC_VERSION}",
    schedule: schedData,
    machines: machData
  })).setMimeType(ContentService.MimeType.JSON);
}

function normalizeDateCell_(val) {
  if (val instanceof Date && !isNaN(val.getTime())) {
    return Utilities.formatDate(val, "Asia/Taipei", "yyyy/MM/dd");
  }
  var s = String(val || "").trim();
  var m = s.match(/^(\\d{4})[-/](\\d{1,2})[-/](\\d{1,2})/);
  if (m) {
    return m[1] + "/" + ("0" + m[2]).slice(-2) + "/" + ("0" + m[3]).slice(-2);
  }
  return s;
}

${classifyRowType.toString()}
${calcStrengthMetrics.toString()}
${calcWalkSpeed.toString()}
${nextWeekDate.toString()}

function updateRow_(sheet, rowNumber, current, formulas, next) {
  var start = -1;
  for (var col = 0; col <= next.length; col++) {
    var changed = col < next.length && !formulas[col] &&
      String(current[col]) !== String(next[col]);
    if (changed) {
      if (start < 0) start = col;
    } else if (start >= 0) {
      sheet.getRange(rowNumber, start + 1, 1, col - start)
        .setValues([next.slice(start, col)]);
      start = -1;
    }
  }
}

function syncSchedule_(sheet, rows, changedColumns) {
  var lastRow = sheet.getLastRow();
  if (lastRow === 0) {
    sheet.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
    return;
  }

  var range = sheet.getRange(1, 1, lastRow, rows[0].length);
  var values = range.getValues();
  var formulas = range.getFormulas();
  var rowIndex = new Map();
  for (var r = 1; r < values.length; r++) {
    var date = normalizeDateCell_(values[r][0]);
    var phase = String(values[r][3] || "").trim();
    if (date && phase) rowIndex.set(date + "||" + phase, r);
  }

  var allUpdateColumns = [4, 5, 6, 11, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27];
  // Activity rows share the sheet layout with strength and walking records.
  var activityUpdateColumns = [4, 5, 11, 23, 24, 25, 26, 27];
  var rowsToAppend = [];
  for (var i = 1; i < rows.length; i++) {
    var incoming = rows[i];
    var key = normalizeDateCell_(incoming[0]) + "||" + String(incoming[3] || "").trim();
    var target = rowIndex.get(key);
    if (target === undefined) {
      rowsToAppend.push(incoming);
      continue;
    }

    var current = values[target];
    var incomingType = classifyRowType(incoming[3], incoming[5]);
    var currentType = classifyRowType(current[3], current[5]);
    var isActivity = incomingType === "cardio" || incomingType === "sport" ||
      currentType === "cardio" || currentType === "sport";
    var columns = isActivity ? activityUpdateColumns : allUpdateColumns;
    var selected = changedColumns ? changedColumns[i - 1] : null;
    var next = current.slice();
    columns.forEach(function(col) {
      if (selected && ([18, 19, 22].includes(col) || !selected.includes(col))) return;
      var value = incoming[col];
      if (formulas[target][col] || value == null || (isActivity && String(value).trim() === "")) return;
      next[col] = value;
    });
    if (selected && !isActivity) {
      if (selected.some(function(col) { return [5, 6, 14, 15, 16, 17].includes(col); })) {
        var metrics = calcStrengthMetrics({
          rowType: incomingType, basis: next[5], baseKg: next[6], addedWeight: next[14],
          unit: next[15], actualSets: next[16], actualReps: next[17]
        });
        if (metrics.effectiveKg !== 0 || current[18] !== "") next[18] = metrics.effectiveKg;
        if (metrics.volumeKg !== 0 || current[19] !== "") next[19] = metrics.volumeKg;
      }
      if (selected.includes(20) || selected.includes(21)) {
        var speed = calcWalkSpeed({ walkKm: next[20], walkMin: next[21] });
        if (speed !== 0 || current[22] !== "") next[22] = speed;
      }
    }
    updateRow_(sheet, target + 1, current, formulas[target], next);
    values[target] = next;
  }

  if (rowsToAppend.length > 0) {
    sheet.getRange(lastRow + 1, 1, rowsToAppend.length, rows[0].length).setValues(rowsToAppend);
  }
}

function appendCopiedDays_(sheet, header, copies) {
  if (!Array.isArray(header) || header.length !== 28) throw new Error("Invalid schedule header");
  var lastRow = sheet.getLastRow();
  var occupied = new Set(lastRow > 1
    ? sheet.getRange(2, 1, lastRow - 1, 1).getValues().map(function(row) { return normalizeDateCell_(row[0]); })
    : []);
  var toAppend = lastRow === 0 ? [header] : [];
  var result = { created: 0, skipped: 0 };
  copies.forEach(function(copy) {
    var date = copy.date;
    if (!nextWeekDate(date) || !Array.isArray(copy.rows) || !copy.rows.length ||
        copy.rows.some(function(row) { return !Array.isArray(row) || row.length !== 28 || row[0] !== date; })) {
      throw new Error("Invalid copied schedule day");
    }
    if (occupied.has(date)) {
      result.skipped++;
      return;
    }
    copy.rows.forEach(function(row) {
      toAppend.push(row.slice(0, 14).concat(Array(14).fill("")));
    });
    occupied.add(date);
    result.created++;
  });
  if (toAppend.length) sheet.getRange(lastRow + 1, 1, toAppend.length, 28).setValues(toAppend);
  return result;
}

function syncMachines_(sheet, machines) {
  var headers = ["ID", "登錄日期", "器材名稱", "分類模式", "評分(1-5)", "座椅/設定參數", "發力感受與筆記"];
  var rows = [headers].concat(machines.map(function(m) {
    return [m.id, m.date || "", m.name || "", m.category || "", m.rating || 5, m.setup || "", m.notes || ""];
  }));
  var width = headers.length;
  var lastRow = sheet.getLastRow();
  if (lastRow > 0) {
    var range = sheet.getRange(1, 1, lastRow, width);
    var values = range.getValues();
    var formulas = range.getFormulas();
    var emptyRow = Array(width).fill("");
    for (var r = 0; r < lastRow; r++) {
      updateRow_(sheet, r + 1, values[r], formulas[r], rows[r] || emptyRow);
    }
  }
  if (rows.length > lastRow) {
    sheet.getRange(lastRow + 1, 1, rows.length - lastRow, width).setValues(rows.slice(lastRow));
  }
}

function syncMachineChanges_(sheet, changes) {
  var lastRow = sheet.getLastRow();
  if (lastRow === 0) {
    syncMachines_(sheet, changes.filter(function(record) { return !record.deleted; }));
    return;
  }
  var range = sheet.getRange(1, 1, lastRow, 7);
  var values = range.getValues();
  var formulas = range.getFormulas();
  var byId = new Map();
  for (var r = 1; r < values.length; r++) {
    if (String(values[r][2] || "").trim()) {
      byId.set(String(values[r][0] || ("mach_cloud_" + (r - 1))), r);
    }
  }
  var appended = [];
  changes.forEach(function(record) {
    var row = byId.get(record.id);
    if (record.deleted && row === undefined) return;
    var next = record.deleted ? Array(7).fill("") :
      [record.id, record.date || "", record.name, record.category || "", record.rating || 5, record.setup || "", record.notes || ""];
    if (row === undefined) appended.push(next);
    else updateRow_(sheet, row + 1, values[row], formulas[row], next);
  });
  if (appended.length > 0) sheet.getRange(lastRow + 1, 1, appended.length, 7).setValues(appended);
}

function doPost(e) {
  var payload = JSON.parse(e.postData.contents);
  var copyResult;
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (payload.autoSyncVersion === "${SYNC_VERSION}") {
      if (payload.scheduleChanges && payload.scheduleChanges.length > 0) {
        var scheduleSheet = ss.getSheetByName("每日詳細訓練課表") || ss.insertSheet("每日詳細訓練課表");
        var rows = [payload.scheduleHeader].concat(payload.scheduleChanges.map(function(edit) { return edit.row; }));
        var columns = payload.scheduleChanges.map(function(edit) { return edit.columns; });
        syncSchedule_(scheduleSheet, rows, columns);
      }
      if (payload.copiedDays && payload.copiedDays.length > 0) {
        var copySheet = ss.getSheetByName("每日詳細訓練課表") || ss.insertSheet("每日詳細訓練課表");
        copyResult = appendCopiedDays_(copySheet, payload.scheduleHeader, payload.copiedDays);
      }
      if (payload.machineChanges && payload.machineChanges.length > 0) {
        var machineSheet = ss.getSheetByName("器械感受收藏庫") || ss.insertSheet("器械感受收藏庫");
        syncMachineChanges_(machineSheet, payload.machineChanges);
      }
    } else if (!payload.autoSyncVersion && payload.schedule && payload.schedule.length > 1) {
      var sheetSched = ss.getSheetByName("每日詳細訓練課表") || ss.insertSheet("每日詳細訓練課表");
      syncSchedule_(sheetSched, payload.schedule);
    }
    if (!payload.autoSyncVersion && payload.machines) {
      var sheetMach = ss.getSheetByName("器械感受收藏庫") || ss.insertSheet("器械感受收藏庫");
      syncMachines_(sheetMach, payload.machines);
    }
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  return ContentService.createTextOutput(JSON.stringify({
    status: "saved",
    syncVersion: "${SYNC_VERSION}",
    copyResult: copyResult
  }))
    .setMimeType(ContentService.MimeType.JSON);
}`;

    function build28ColRows(sourceItems = items) {
      const headers = [
        "日期", "星期", "課表模組", "階段 / 類別", "動作 / 有氧項目名稱", "計量基準",
        "空槓/機台重(kg)", "目標組數", "目標次數 / 時間", "組間休息", "建議強度 / 步速",
        "作法與力學修正要點", "目標訓練部位", "示範短影片", "外加/手持重量", "單位",
        "實際組數", "實際次數(單組)", "單組有效總重(kg)", "總訓練容量 Volume(kg)",
        "散步距離 (km)", "散步時長 (分鐘)", "散步均速 (km/h)",
        "有氧距離 (km)", "有氧時長 (分鐘)", "有氧速度 (km/h)", "有氧坡度 (%)", "完成檢核"
      ];
      const rows = sourceItems.map(it => {
        const m = calcStrengthMetrics(it);
        const wSpd = calcWalkSpeed(it);
        if (it.rowType === "sport" || it.rowType === "cardio") {
          const corosParts = [];
          if (it.sportAvgHr) corosParts.push(`均心率 ${it.sportAvgHr} bpm`);
          if (it.sportKcal) corosParts.push(`卡路里 ${it.sportKcal} kcal`);
          if (it.sportLoad) corosParts.push(`訓練負荷 ${it.sportLoad}`);
          if (it.sportAerobicTe !== "" && it.sportAerobicTe !== undefined) corosParts.push(`有氧效果 ${it.sportAerobicTe}`);
          if (it.sportAnaerobicTe !== "" && it.sportAnaerobicTe !== undefined) corosParts.push(`無氧效果 ${it.sportAnaerobicTe}`);
          const metaSummary = corosParts.join(" / ");
          const combinedNotes = [it.sportNotes || "", metaSummary].filter(Boolean).join("｜") || it.cues;
          return [
            it.date, it.weekday, it.module, it.phase, it.name, it.basis || "COROS 生理數據",
            it.baseKg ?? 0, it.targetSets || 0, it.targetReps || "依 COROS 運動時間紀錄", it.rest || "-", it.rpe || "COROS 概要數據",
            combinedNotes, it.muscles, getExerciseVideo(it), it.addedWeight ?? "", it.unit ?? "",
            it.actualSets ?? "", it.actualReps ?? "", m.effectiveKg, m.volumeKg,
            it.walkKm ?? "", it.walkMin ?? "", wSpd,
            it.cardioKm ?? "", String(it.sportMin ?? "").trim() || it.cardioMin || "",
            it.cardioSpeed ?? "", it.cardioIncline ?? "", it.status
          ];
        }
        return [
          it.date, it.weekday, it.module, it.phase, it.name, it.basis,
          it.baseKg, it.targetSets, it.targetReps, it.rest, it.rpe,
          it.cues, it.muscles, getExerciseVideo(it), it.addedWeight, it.unit,
          it.actualSets, it.actualReps, m.effectiveKg, m.volumeKg,
          it.walkKm, it.walkMin, wSpd,
          it.cardioKm, it.cardioMin, it.cardioSpeed, it.cardioIncline, it.status
        ];
      });
      return [headers, ...rows];
    }

    function escapeHtml(str) {
      return String(str || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    document.addEventListener("DOMContentLoaded", () => {
      loadLocalCache();
      try {
        photoChanges = new Map(JSON.parse(localStorage.getItem(STORAGE_KEY_PHOTO_QUEUE) || "[]"));
      } catch {
        photoChanges = new Map();
      }
      renderScheduleView();
      renderStarSelector();
      renderMachineLibrary();

      syncFromCloud();
      window.addEventListener("online", syncFromCloud);
      window.addEventListener("online", refreshMachinePhotos);
      window.addEventListener("offline", syncFromCloud);
      document.addEventListener("visibilitychange", () => {
        if (!document.hidden || hasPendingEdits()) syncFromCloud({ keepalive: document.hidden });
        if (!document.hidden) refreshMachinePhotos();
      });
      setInterval(() => {
        if (!document.hidden) {
          syncFromCloud();
          if (photoAuthorized || photoChanges.size) refreshMachinePhotos();
        }
      }, 30000);

      document.querySelectorAll(".nav-tab").forEach(tab => {
        tab.addEventListener("click", () => {
          document.querySelectorAll(".nav-tab").forEach(t => t.classList.remove("active"));
          document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
          tab.classList.add("active");
          const targetId = tab.dataset.tab;
          document.getElementById(targetId).classList.add("active");
          if (targetId === "tab-overview") renderOverviewView();
          if (targetId === "tab-machines") {
            renderMachineLibrary();
            refreshMachinePhotos();
          }
        });
      });
      if (location.hash === "#machines") {
        document.querySelector('[data-tab="tab-machines"]').click();
        const login = new URLSearchParams(location.search).get("photoLogin");
        if (login) {
          showToast(login === "account" ? "請使用手機和電腦共用的 Google 帳號。" : "未完成照片同步登入，請重試。");
          history.replaceState(null, "", location.pathname + "#machines");
        }
      } else if (photoChanges.size) {
        refreshMachinePhotos();
      }
      document.getElementById("photoSignOut").addEventListener("click", async () => {
        photoSessionRevision++;
        try {
          const result = await fetch(PRIVATE_PHOTO_API + "?action=logout", { method: "POST" });
          if (!result.ok) throw new Error("Sign out failed");
          endPhotoSession();
          setPhotoSyncStatus("已登出私人照片同步", true);
        } catch {
          showToast("暫時無法登出，請重試。");
        }
      });

      document.getElementById("mPhotoInput").addEventListener("change", async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
          currentFormPhoto = await compressImageFile(file);
          formPhotoChanged = true;
          document.getElementById("mPhotoPreview").src = currentFormPhoto;
          document.getElementById("mPhotoPreviewWrap").style.display = "flex";
        } catch (err) {
          showToast("照片讀取失敗，請重試");
        }
      });

      document.getElementById("mClearPhotoBtn").addEventListener("click", () => {
        currentFormPhoto = "";
        formPhotoChanged = true;
        document.getElementById("mPhotoInput").value = "";
        document.getElementById("mPhotoPreviewWrap").style.display = "none";
      });

      document.getElementById("mSaveBtn").addEventListener("click", () => {
        const name = document.getElementById("mName").value.trim();
        if (!name) {
          showToast("請輸入器材名稱");
          return;
        }
        const category = document.getElementById("mCategory").value;
        const setup = document.getElementById("mSetup").value.trim();
        const notes = document.getElementById("mNotes").value.trim();
        const todayStr = getTodayDateStr();
        let machineSaved;

        if (editingMachineId) {
          const idx = machines.findIndex(x => x.id === editingMachineId);
          if (idx !== -1) {
            machines[idx] = { ...machines[idx], name, category, setup, notes, rating: currentFormRating, photo: currentFormPhoto, localOnly: false };
            queueMachineEdit(machines[idx]);
            machineSaved = machines[idx];
          }
          showToast("已更新器械紀錄");
        } else {
          machines.unshift({
            id: "mach_" + crypto.randomUUID(),
            date: todayStr,
            name,
            category,
            setup,
            notes,
            rating: currentFormRating,
            photo: currentFormPhoto
          });
          queueMachineEdit(machines[0]);
          machineSaved = machines[0];
          showToast("已新增至器械收藏庫");
        }
        saveState();
        if (machineSaved && formPhotoChanged) queuePhotoChange(machineSaved.id, !currentFormPhoto);
        resetMachineForm();
        renderMachineLibrary();
      });

      document.getElementById("mCancelEditBtn").addEventListener("click", resetMachineForm);

      document.getElementById("copyMachinesBtn").addEventListener("click", () => {
        if (machines.length === 0) {
          showToast("目前尚未收藏任何器械");
          return;
        }
        const lines = ["【我的健身房器械感受收藏庫】"];
        machines.forEach((m, i) => {
          lines.push(`${i + 1}. [${m.category}] ${m.name}（${m.rating}★）`);
          if (m.setup) lines.push(`   - 座椅/設定：${m.setup}`);
          if (m.notes) lines.push(`   - 發力筆記：${m.notes}`);
        });
        navigator.clipboard.writeText(lines.join("\n")).then(() => {
          showToast("已複製清單，可直接貼給教練排課！");
        });
      });

      document.getElementById("imgModal").addEventListener("click", () => {
        document.getElementById("imgModal").classList.remove("open");
      });

      document.getElementById("exportCsvBtn").addEventListener("click", () => {
        const rows = build28ColRows();
        const csvText = "\uFEFF" + rows.map(r => r.map(v => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")).join("\n");
        const blob = new Blob([csvText], { type: "text/csv;charset=utf-8;" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `訓練動態追蹤_全歷史_${getTodayDateStr().replace(/\//g, "")}.csv`;
        a.click();
      });

      document.getElementById("exportJsonBtn").addEventListener("click", () => {
        downloadBackup(items, "workout_tracker");
      });
      const preSyncBtn = document.getElementById("exportPreSyncBtn");
      const preSyncItems = localStorage.getItem(STORAGE_KEY_PRE_SYNC_ITEMS);
      preSyncBtn.hidden = !preSyncItems;
      preSyncBtn.addEventListener("click", () => {
        downloadBackup(JSON.parse(preSyncItems), "workout_before_auto_sync");
      });

      function downloadBackup(backupItems, filename) {
        const backup = { version: "dynamic_v3", exportedAt: new Date().toISOString(), items: backupItems, machines };
        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `${filename}_backup_${getTodayDateStr().replace(/\//g, "")}.json`;
        a.click();
      }

      document.getElementById("importJsonInput").addEventListener("change", (e) => {
        const file = e.target.files[0];
        if (!file) return;
        e.target.value = "";
        const reader = new FileReader();
        reader.onload = (ev) => {
          try {
            const parsed = JSON.parse(ev.target.result);
            if (!Array.isArray(parsed.items) && !Array.isArray(parsed.machines)) throw new Error("Invalid workout backup");
            if (!confirm("還原的資料會自動同步至 Google 試算表，並更新相同的紀錄。確定要還原嗎？")) return;
            if (Array.isArray(parsed.items)) {
              const previousRows = new Map(build28ColRows().slice(1).map(row => [scheduleKey(row), row]));
              items = parsed.items.map(it => ({
                ...it,
                rowType: classifyRowType(it.phase, it.basis)
              }));
              items.forEach(item => {
                const row = build28ColRows([item])[1];
                queueWorkoutEdit(item, previousRows.get(scheduleKey(row)));
              });
            }
            if (Array.isArray(parsed.machines)) {
              machines = parsed.machines;
              machines.forEach(queueMachineEdit);
            }
            pickBestDateAndWeek(false);
            saveState();
            renderScheduleView();
            renderMachineLibrary();
            showToast("✅ 已成功還原備份資料");
          } catch (err) {
            showToast("❌ JSON 檔案格式錯誤");
          }
        };
        reader.readAsText(file);
      });

    });
