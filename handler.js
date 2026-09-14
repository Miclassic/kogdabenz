// src/feedback/handler.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

class FeedbackHandler {
  constructor() {
    this.feedbackTypes = {
      delivery: {
        event_type: 'possible_delivery',
        confidence: 0.9,
        description: 'Привезли топливо'
      },
      available: {
        event_type: 'fuel_available',
        confidence: 0.85,
        description: 'Топливо было'
      },
      unavailable: {
        event_type: 'fuel_unavailable',
        confidence: 0.85,
        description: 'Топлива не было'
      },
      queue: {
        event_type: 'queue_high',
        confidence: 0.8,
        description: 'Большая очередь'
      },
      free: {
        event_type: 'queue_low',
        confidence: 0.8,
        description: 'Свободно'
      }
    };
  }

  // Обработка обратной связи от пользователя
  async processFeedback(stationId, feedbackType, userId = null) {
    const feedbackConfig = this.feedbackTypes[feedbackType];
    
    if (!feedbackConfig) {
      throw new Error(`Неизвестный тип обратной связи: ${feedbackType}`);
    }

    console.log(`Обработка обратной связи: ${feedbackConfig.description}`);

    // Сохраняем наблюдение
    const observation = {
      station_id: stationId,
      timestamp: new Date().toISOString(),
      fuel_92_status: feedbackType === 'available',
      fuel_95_status: feedbackType === 'available',
      diesel_status: feedbackType === 'available',
      queue_level: feedbackType === 'queue' ? 'high' : 
                   feedbackType === 'free' ? 'low' : null,
      data_freshness_minutes: 0
    };

    const { data: obsData, error: obsError } = await supabase
      .from('observations')
      .insert(observation)
      .select()
      .single();

    if (obsError) throw obsError;

    // Создаём событие
    const event = {
      station_id: stationId,
      event_type: feedbackConfig.event_type,
      detected_at: new Date().toISOString(),
      confidence: feedbackConfig.confidence,
      source: 'user_feedback',
      metadata: {
        feedback_type: feedbackType,
        user_id: userId,
        description: feedbackConfig.description
      }
    };

    const { data: eventData, error: eventError } = await supabase
      .from('events')
      .insert(event)
      .select()
      .single();

    if (eventError) throw eventError;

    console.log(`✓ Обратная связь сохранена для станции ${stationId}`);

    return {
      observation: obsData,
      event: eventData,
      message: 'Спасибо! Ваше наблюдение учтено'
    };
  }

  // Получение статистики обратной связи
  async getFeedbackStats(stationId) {
    const { data, error } = await supabase
      .from('events')
      .select('*')
      .eq('station_id', stationId)
      .eq('source', 'user_feedback')
      .order('detected_at', { ascending: false });

    if (error) throw error;

    const stats = {
      total_feedback: data.length,
      delivery_reports: data.filter(e => e.event_type === 'possible_delivery').length,
      availability_reports: data.filter(e => e.event_type === 'fuel_available').length,
      unavailability_reports: data.filter(e => e.event_type === 'fuel_unavailable').length,
      queue_reports: data.filter(e => e.event_type === 'queue_high').length
    };

    return stats;
  }

  // Валидация обратной связи (защита от спама)
  async validateFeedback(stationId, userId, timeWindowMinutes = 30) {
    const timeWindowAgo = new Date(Date.now() - timeWindowMinutes * 60 * 1000);

    const { data, error } = await supabase
      .from('events')
      .select('*')
      .eq('station_id', stationId)
      .eq('source', 'user_feedback')
      .eq('metadata->>user_id', userId)
      .gte('detected_at', timeWindowAgo.toISOString());

    if (error) throw error;

    if (data.length > 3) {
      return {
        valid: false,
        reason: 'Слишком много наблюдений за короткий период'
      };
    }

    return {
      valid: true
    };
  }
}

export default FeedbackHandler;