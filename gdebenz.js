// src/collector/gdebenz.js
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

class GdeBenzCollector {
  constructor() {
    this.baseUrl = 'https://gdebenz.ru/api';
    this.pollInterval = 10 * 60 * 1000; // 10 минут
  }

  // Получение списка всех АЗС
  async getAllStations() {
    try {
      const response = await axios.get(`${this.baseUrl}/stations`);
      return response.data.stations;
    } catch (error) {
      console.error('Ошибка получения станций:', error);
      return [];
    }
  }

  // Получение данных конкретной АЗС
  async getStationData(stationId) {
    try {
      const response = await axios.get(`${this.baseUrl}/stations/${stationId}`);
      return response.data;
    } catch (error) {
      console.error(`Ошибка получения данных АЗС ${stationId}:`, error);
      return null;
    }
  }

  // Получение комментариев АЗС
  async getComments(stationId) {
    try {
      const response = await axios.get(`${this.baseUrl}/stations/${stationId}/comments`);
      return response.data.comments;
    } catch (error) {
      console.error(`Ошибка получения комментариев ${stationId}:`, error);
      return [];
    }
  }

  // Сохранение станции в БД
  async saveStation(stationData) {
    const { data, error } = await supabase
      .from('stations')
      .upsert({
        external_id: stationData.id,
        name: stationData.name,
        brand: stationData.brand,
        address: stationData.address,
        lat: stationData.latitude,
        lon: stationData.longitude,
        source: 'gdebenz'
      }, {
        onConflict: 'external_id,source'
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  // Сохранение наблюдения
  async saveObservation(stationId, observationData) {
    const { data, error } = await supabase
      .from('observations')
      .insert({
        station_id: stationId,
        fuel_92_status: observationData.fuel_92_available,
        fuel_95_status: observationData.fuel_95_available,
        diesel_status: observationData.diesel_available,
        price_92: observationData.price_92,
        price_95: observationData.price_95,
        price_diesel: observationData.price_diesel,
        queue_level: observationData.queue_level,
        data_freshness_minutes: observationData.last_update_minutes
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  // Сохранение комментария
  async saveComment(stationId, comment) {
    const { error } = await supabase
      .from('comments')
      .insert({
        station_id: stationId,
        external_id: comment.id,
        comment_text: comment.text,
        timestamp: new Date(comment.timestamp),
        source: 'gdebenz'
      });

    if (error) throw error;
  }

  // Основной цикл сбора данных
  async collectAll() {
    console.log(`[${new Date().toISOString()}] Начало сбора данных...`);
    
    const stations = await this.getAllStations();
    console.log(`Получено станций: ${stations.length}`);

    for (const station of stations) {
      try {
        // Сохраняем/обновляем станцию
        const savedStation = await this.saveStation(station);
        
        // Получаем актуальные данные
        const stationData = await this.getStationData(station.id);
        if (stationData) {
          await this.saveObservation(savedStation.id, stationData);
        }

        // Получаем комментарии
        const comments = await this.getComments(station.id);
        for (const comment of comments) {
          await this.saveComment(savedStation.id, comment);
        }

        // Задержка между запросами, чтобы не нагружать API
        await this.sleep(100);
        
      } catch (error) {
        console.error(`Ошибка обработки станции ${station.id}:`, error);
      }
    }

    console.log(`[${new Date().toISOString()}] Сбор данных завершён`);
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Запуск периодического сбора
  start() {
    console.log('Запуск сборщика GdeBenz...');
    this.collectAll();
    setInterval(() => this.collectAll(), this.pollInterval);
  }
}

export default GdeBenzCollector;