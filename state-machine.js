// ===== State Machine Analyzer v1.0 =====
// Читает историю наблюдений и пересчитывает состояние топлива (AVAILABLE / LOSS / RECOVERY)
// Запускается отдельно от collector.js, чтобы не рисковать сбором данных.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Конфигурация машины состояний
const CONFIG = {
  LOOKBACK_HOURS: 24, // Сколько часов истории смотреть
  BATCH_SIZE: 50,     // Сколько станций обрабатывать за один запрос к DB
  MIN_OBSERVATIONS_FOR_STATE: 3, // Минимум наблюдений, чтобы точно определить состояние
  
  // Пороги для подтверждения потери/восстановления
  // Например, если топливо пропало 2 раза подряд -> CONFIRMED_LOSS
  CONSECUTIVE_MISSING_TO_CONFIRM: 2, 
  
  // Если топливо появилось 1 раз после долгого отсутствия -> RECOVERING
  // Если оно держится 2 цикла -> AVAILABLE
  CONSECUTIVE_PRESENT_TO_RESTORE: 2
};

async function sbGet(path) {
  const r = await fetch(SUPABASE_URL + path, {
    headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY }
  });
  if (!r.ok) throw new Error('GET ' + path + ' → ' + r.status);
  return r.json();
}

async function sbPatch(table, id, data) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(data)
  });
  if (!r.ok) throw new Error(`PATCH ${table}/${id} failed`);
}

// Основная функция анализа одной станции
function analyzeStationHistory(history) {
  if (!history || history.length === 0) return null;

  // Сортируем от старых к новым
  const sorted = [...history].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  
  let currentState = sorted[0].fuel_state || 'UNKNOWN';
  let consecutiveMissing = 0;
  let consecutivePresent = 0;

  // Проходим по всей истории, чтобы найти текущее состояние
  // Но нас интересует только ПОСЛЕДНЕЕ значение, которое мы запишем в базу
  for (let i = 0; i < sorted.length; i++) {
    const obs = sorted[i];
    const isAvailable = obs.fuel_95_status === true;
    const isMissing = obs.fuel_95_status === false;
    
    // Логика переходов
    if (isAvailable) {
      consecutiveMissing = 0;
      consecutivePresent++;
      
      if (currentState === 'CONFIRMED_LOSS' || currentState === 'SUSPECTED_LOSS') {
        // Был дефицит, стало есть
        if (consecutivePresent >= CONFIG.CONSECUTIVE_PRESENT_TO_RESTORE) {
          currentState = 'AVAILABLE';
        } else {
          currentState = 'RECOVERING';
        }
      } else if (currentState === 'RECOVERING') {
         if (consecutivePresent >= CONFIG.CONSECUTIVE_PRESENT_TO_RESTORE) {
           currentState = 'AVAILABLE';
         }
      } else {
        currentState = 'AVAILABLE';
      }
    } 
    else if (isMissing) {
      consecutivePresent = 0;
      consecutiveMissing++;
      
      if (currentState === 'AVAILABLE') {
        // Было есть, стало нет
        if (consecutiveMissing >= CONFIG.CONSECUTIVE_MISSING_TO_CONFIRM) {
          currentState = 'CONFIRMED_LOSS';
        } else {
          currentState = 'SUSPECTED_LOSS';
        }
      } else if (currentState === 'SUSPECTED_LOSS') {
        if (consecutiveMissing >= CONFIG.CONSECUTIVE_MISSING_TO_CONFIRM) {
          currentState = 'CONFIRMED_LOSS';
        }
      } else if (currentState === 'CONFIRMED_LOSS') {
        // Остаемся в подтвержденном потере
        currentState = 'CONFIRMED_LOSS';
      }
    }
    // Если статус null (нет данных), ничего не меняем, просто пропускаем шаг
  }

  return {
    finalState: currentState,
    lastObsId: sorted[sorted.length - 1].id, // ID последнего наблюдения, куда пишем результат
    confidence: calculateConfidence(sorted, currentState)
  };
}

// Простая эвристика уверенности
function calculateConfidence(history, state) {
  const total = history.filter(h => h.fuel_95_status !== null).length;
  if (total === 0) return 0;
  
  // Чем больше наблюдений в окне, тем выше уверенность
  // Кап на 0.95
  let conf = Math.min(0.95, total / 10); 
  
  // Если состояние нестабильное (часто меняется), снижаем уверенность
  let switches = 0;
  for(let i=1; i<history.length; i++) {
    if (history[i].fuel_95_status !== history[i-1].fuel_95_status && 
        history[i].fuel_95_status !== null && history[i-1].fuel_95_status !== null) {
      switches++;
    }
  }
  if (switches > 3) conf *= 0.8;
  
  return parseFloat(conf.toFixed(3));
}

async function main() {
  console.log('🚀 Starting State Machine Analysis...');
  
  // 1. Получаем список всех уникальных станций, у которых были наблюдения за последние сутки
  const since = new Date(Date.now() - CONFIG.LOOKBACK_HOURS * 3600 * 1000).toISOString();
  
  // Запрос на получение последних наблюдений для группировки по станциям
  // PostgREST позволяет фильтровать, но не делает GROUP BY эффективно для этого случая.
  // Поэтому получим все свежие наблюдения и сгруппируем в JS.
  
  const rawObservations = await sbGet(`/rest/v1/observations?timestamp=gte.${since}&select=id,station_id,fuel_95_status,timestamp,fuel_state&order=timestamp.asc`);
  
  if (!rawObservations.length) {
    console.log('No recent observations found.');
    return;
  }

  // Группируем по station_id
  const stationsMap = {};
  for (const obs of rawObservations) {
    if (!stationsMap[obs.station_id]) stationsMap[obs.station_id] = [];
    stationsMap[obs.station_id].push(obs);
  }

  const stationIds = Object.keys(stationsMap);
  console.log(`Found ${stationIds.length} active stations.`);

  let updatedCount = 0;
  let errorCount = 0;

  // Обрабатываем батчами
  for (let i = 0; i < stationIds.length; i += CONFIG.BATCH_SIZE) {
    const batch = stationIds.slice(i, i + CONFIG.BATCH_SIZE);
    const promises = [];

    for (const sid of batch) {
      const history = stationsMap[sid];
      try {
        const result = analyzeStationHistory(history);
        
        if (result && result.finalState !== 'UNKNOWN') {
          // Обновляем ТОЛЬКО последнее наблюдение в цепочке, чтобы не плодить записи
          // В реальной системе лучше создать отдельную таблицу station_current_states
          // Но для MVP обновим последнюю запись в observations
          
          const updatePromise = sbPatch('observations', result.lastObsId, {
            fuel_state: result.finalState,
            reliability_score: result.confidence
          });
          promises.push(updatePromise.then(() => updatedCount++));
        }
      } catch (e) {
        console.error(`Error analyzing station ${sid}:`, e.message);
        errorCount++;
      }
    }

    await Promise.all(promises);
    console.log(`Processed batch ${Math.floor(i/CONFIG.BATCH_SIZE)+1}/${Math.ceil(stationIds.length/CONFIG.BATCH_SIZE)}... Updated: ${updatedCount}`);
  }

  console.log(`✅ Done. Updated: ${updatedCount}, Errors: ${errorCount}`);
}

main().catch(e => {
  console.error('❌ Critical failure:', e);
  process.exit(1);
});