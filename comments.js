// src/detector/comments.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

class CommentAnalyzer {
  constructor() {
    // Словарь ключевых слов
    this.keywords = {
      delivery: ['привезли', 'бензовоз', 'завезли', 'только что', 'поставка', 'привез'],
      no_fuel: ['нет', 'закончился', 'отсутствует', 'нет бензина', 'нет 95'],
      queue_high: ['очередь', 'много машин', 'долго', 'большая очередь'],
      queue_low: ['свободно', 'нет очереди', 'быстро']
    };
  }

  // Анализ текста комментария
  analyzeComment(text) {
    const lowerText = text.toLowerCase();
    const signals = [];

    // Проверка на поставку
    for (const keyword of this.keywords.delivery) {
      if (lowerText.includes(keyword)) {
        signals.push({
          type: 'possible_delivery',
          confidence: 0.7,
          keyword: keyword
        });
        break;
      }
    }

    // Проверка на отсутствие топлива
    for (const keyword of this.keywords.no_fuel) {
      if (lowerText.includes(keyword)) {
        signals.push({
          type: 'fuel_unavailable',
          confidence: 0.6,
          keyword: keyword
        });
        break;
      }
    }

    // Проверка на очередь
    for (const keyword of this.keywords.queue_high) {
      if (lowerText.includes(keyword)) {
        signals.push({
          type: 'queue_high',
          confidence: 0.65,
          keyword: keyword
        });
        break;
      }
    }

    return signals;
  }

  // Обработка новых комментариев
  async processNewComments() {
    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);

    const { data: comments, error } = await supabase
      .from('comments')
      .select('id, station_id, comment_text, timestamp')
      .gte('timestamp', thirtyMinutesAgo.toISOString());

    if (error) throw error;

    console.log(`Анализ ${comments.length} новых комментариев...`);

    for (const comment of comments) {
      const signals = this.analyzeComment(comment.comment_text);

      for (const signal of signals) {
        await supabase.from('events').insert({
          station_id: comment.station_id,
          event_type: signal.type,
          detected_at: comment.timestamp,
          confidence: signal.confidence,
          source: 'comment',
          metadata: {
            comment_id: comment.id,
            keyword: signal.keyword,
            text: comment.comment_text
          }
        });
      }
    }
  }
}

export default CommentAnalyzer;