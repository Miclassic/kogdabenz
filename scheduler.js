// src/collector/scheduler.js
import GdeBenzCollector from './gdebenz.js';
import EventDetector from '../detector/events.js';
import CommentAnalyzer from '../detector/comments.js';
import PredictionEngine from '../predictor/statistics.js';
import PredictionVerifier from '../predictor/confidence.js';

class Scheduler {
  constructor() {
    this.collector = new GdeBenzCollector();
    this.eventDetector = new EventDetector();
    this.commentAnalyzer = new CommentAnalyzer();
    this.predictionEngine = new PredictionEngine();
    this.verifier = new PredictionVerifier();
  }

  async runFullCycle() {
    console.log('\n========================================');
    console.log(`Запуск полного цикла: ${new Date().toISOString()}`);
    console.log('========================================\n');

    try {
      // 1. Сбор данных
      console.log('[1/5] Сбор данных с GdeBenz...');
      await this.collector.collectAll();

      // 2. Обнаружение событий
      console.log('\n[2/5] Обнаружение изменений...');
      await this.eventDetector.processAllStations();

      // 3. Анализ комментариев
      console.log('\n[3/5] Анализ комментариев...');
      await this.commentAnalyzer.processNewComments();

      // 4. Генерация прогнозов
      console.log('\n[4/5] Генерация прогнозов...');
      await this.predictionEngine.generateAllPredictions();

      // 5. Проверка старых прогнозов
      console.log('\n[5/5] Проверка точности прогнозов...');
      await this.verifier.verifyPredictions();

      console.log('\n✅ Полный цикл завершён успешно!\n');
    } catch (error) {
      console.error('\n❌ Ошибка в полном цикле:', error);
    }
  }

  start() {
    console.log('🚀 Запуск планировщика...');
    console.log('Циклы будут выполняться каждые 10 минут\n');

    // Первый запуск сразу
    this.runFullCycle();

    // Повтор каждые 10 минут
    setInterval(() => {
      this.runFullCycle();
    }, 10 * 60 * 1000);
  }
}

// Запуск
const scheduler = new Scheduler();
scheduler.start();