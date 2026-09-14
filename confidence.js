// src/predictor/confidence.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

class PredictionVerifier {
  constructor() {
    this.toleranceMinutes = 30; // Допустимое отклонение
  }

  // Проверка всех непроверенных прогнозов
  async verifyPredictions() {
    const { data: predictions, error } = await supabase
      .from('predictions')
      .select('*')
      .eq('result', 'PENDING')
      .lte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());

    if (error) throw error;

    console.log(`Проверка ${predictions.length} прогнозов...`);

    for (const prediction of predictions) {
      await this.verifyPrediction(prediction);
    }
  }

  // Проверка одного прогноза
  async verifyPrediction(prediction) {
    // Ищем фактические события восстановления в день прогноза
    const predictionDate = new Date(prediction.created_at);
    const startOfDay = new Date(predictionDate);
    startOfDay.setHours(0, 0, 0, 0);
    
    const endOfDay = new Date(predictionDate);
    endOfDay.setHours(23, 59, 59, 999);

    const { data: events, error } = await supabase
      .from('events')
      .select('detected_at')
      .eq('station_id', prediction.station_id)
      .eq('event_type', 'fuel_restored')
      .eq('fuel_type', prediction.fuel_type)
      .gte('detected_at', startOfDay.toISOString())
      .lte('detected_at', endOfDay.toISOString());

    if (error) throw error;

    if (events.length === 0) {
      // Не было события восстановления - прогноз MISS
      await this.updatePredictionResult(prediction.id, 'MISS', null);
      return;
    }

    // Проверяем, попадает ли фактическое событие в диапазон прогноза
    const fromTime = this.timeToMinutes(prediction.from_time);
    const toTime = this.timeToMinutes(prediction.to_time);

    for (const event of events) {
      const eventTime = this.timeToMinutes(event.detected_at);
      
      if (eventTime >= fromTime - this.toleranceMinutes && 
          eventTime <= toTime + this.toleranceMinutes) {
        // Прогноз сбылся!
        await this.updatePredictionResult(
          prediction.id,
          'SUCCESS',
          event.detected_at
        );
        return;
      }
    }

    // Событие было, но не в прогнозируемом диапазоне
    await this.updatePredictionResult(prediction.id, 'MISS', null);
  }

  // Обновление результата прогноза
  async updatePredictionResult(predictionId, result, actualTime) {
    const updateData = {
      result: result,
      is_verified: true
    };

    if (actualTime) {
      const date = new Date(actualTime);
      updateData.actual_event_time = 
        `${String(date.getHours()).padStart(2, '0')}:` +
        `${String(date.getMinutes()).padStart(2, '0')}:00`;
    }

    const { error } = await supabase
      .from('predictions')
      .update(updateData)
      .eq('id', predictionId);

    if (error) throw error;

    console.log(`Прогноз ${predictionId}: ${result}`);
  }

  // Преобразование времени в минуты
  timeToMinutes(timeString) {
    const [hours, minutes] = timeString.split(':').map(Number);
    return hours * 60 + minutes;
  }

  // Расчёт общей точности для станции
  async calculateAccuracy(stationId, fuelType) {
    const { data: predictions, error } = await supabase
      .from('predictions')
      .select('*')
      .eq('station_id', stationId)
      .eq('fuel_type', fuelType)
      .eq('is_verified', true);

    if (error) throw error;

    if (predictions.length === 0) {
      return {
        has_data: false,
        accuracy: 0,
        total_predictions: 0
      };
    }

    const successful = predictions.filter(p => p.result === 'SUCCESS').length;
    const accuracy = (successful / predictions.length) * 100;

    return {
      has_data: true,
      accuracy: accuracy.toFixed(1),
      successful_predictions: successful,
      total_predictions: predictions.length
    };
  }
}

export default PredictionVerifier;