// src/predictor/statistics.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

class PredictionEngine {
  constructor() {
    this.minObservations = 5; // Минимум событий для прогноза
  }

  // Получение истории событий восстановления топлива
  async getRestorationHistory(stationId, fuelType, days = 30) {
    const daysAgo = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const { data, error } = await supabase
      .from('events')
      .select('detected_at')
      .eq('station_id', stationId)
      .eq('event_type', 'fuel_restored')
      .eq('fuel_type', fuelType)
      .gte('detected_at', daysAgo.toISOString())
      .order('detected_at', { ascending: true });

    if (error) throw error;
    return data;
  }

  // Расчёт статистики по времени восстановления
  calculateTimeStatistics(events) {
    if (events.length < this.minObservations) {
      return {
        has_enough_data: false,
        observation_count: events.length
      };
    }

    // Извлекаем время суток в минутах
    const times = events.map(event => {
      const date = new Date(event.detected_at);
      return date.getHours() * 60 + date.getMinutes();
    });

    // Сортируем для расчёта медианы
    times.sort((a, b) => a - b);

    // Медиана
    const median = times.length % 2 === 0
      ? (times[times.length / 2 - 1] + times[times.length / 2]) / 2
      : times[Math.floor(times.length / 2)];

    // Стандартное отклонение
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    const variance = times.reduce((sum, time) => sum + Math.pow(time - mean, 2), 0) / times.length;
    const stdDev = Math.sqrt(variance);

    // Группировка по дням недели
    const weekdayGroups = {};
    events.forEach(event => {
      const date = new Date(event.detected_at);
      const dayOfWeek = date.getDay();
      const minutes = date.getHours() * 60 + date.getMinutes();
      
      if (!weekdayGroups[dayOfWeek]) {
        weekdayGroups[dayOfWeek] = [];
      }
      weekdayGroups[dayOfWeek].push(minutes);
    });

    return {
      has_enough_data: true,
      observation_count: events.length,
      median_minutes: Math.round(median),
      std_dev_minutes: Math.round(stdDev),
      from_time_minutes: Math.round(median - stdDev),
      to_time_minutes: Math.round(median + stdDev),
      weekday_patterns: weekdayGroups
    };
  }

  // Создание прогноза
  async generatePrediction(stationId, fuelType) {
    const events = await this.getRestorationHistory(stationId, fuelType);
    const stats = this.calculateTimeStatistics(events);

    if (!stats.has_enough_data) {
      return {
        has_prediction: false,
        reason: 'Недостаточно данных для прогноза',
        observation_count: stats.observation_count
      };
    }

    // Конвертация минут в часы:минуты
    const fromTime = this.minutesToTime(stats.from_time_minutes);
    const toTime = this.minutesToTime(stats.to_time_minutes);

    // Расчёт уверенности (простая формула)
    const confidence = Math.min(
      0.95,
      0.5 + (stats.observation_count / 100) + (1 / (1 + stats.std_dev_minutes / 60))
    );

    const prediction = {
      station_id: stationId,
      fuel_type: fuelType,
      from_time: fromTime,
      to_time: toTime,
      confidence: confidence.toFixed(2),
      based_on_observations: stats.observation_count,
      algorithm_version: 'v1.0',
      result: 'PENDING'
    };

    // Сохраняем прогноз
    const { data, error } = await supabase
      .from('predictions')
      .insert(prediction)
      .select()
      .single();

    if (error) throw error;

    return {
      has_prediction: true,
      prediction: data,
      statistics: stats
    };
  }

  // Преобразование минут в формат времени
  minutesToTime(minutes) {
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:00`;
  }

  // Генерация прогнозов для всех станций
  async generateAllPredictions() {
    const { data: stations, error } = await supabase
      .from('stations')
      .select('id');

    if (error) throw error;

    console.log(`Генерация прогнозов для ${stations.length} станций...`);

    const fuelTypes = ['92', '95', 'diesel'];

    for (const station of stations) {
      for (const fuelType of fuelTypes) {
        try {
          const result = await this.generatePrediction(station.id, fuelType);
          
          if (result.has_prediction) {
            console.log(
              `Прогноз для станции ${station.id}, топливо ${fuelType}: ` +
              `${result.prediction.from_time}-${result.prediction.to_time} ` +
              `(уверенность: ${result.prediction.confidence})`
            );
          }
        } catch (error) {
          console.error(
            `Ошибка генерации прогноза для станции ${station.id}, ${fuelType}:`,
            error
          );
        }
      }
    }
  }
}

export default PredictionEngine;