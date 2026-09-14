// src/detector/events.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

class EventDetector {
  constructor() {
    this.fuelTypes = ['fuel_92', 'fuel_95', 'diesel'];
  }

  // Получение последних двух наблюдений для станции
  async getLastObservations(stationId, limit = 2) {
    const { data, error } = await supabase
      .from('observations')
      .select('*')
      .eq('station_id', stationId)
      .order('timestamp', { ascending: false })
      .limit(limit);

    if (error) throw error;
    return data;
  }

  // Обнаружение изменения статуса топлива
  async detectFuelChanges(stationId) {
    const observations = await this.getLastObservations(stationId, 2);
    
    if (observations.length < 2) return [];

    const [current, previous] = observations;
    const events = [];

    for (const fuelType of this.fuelTypes) {
      const currentStatus = current[`${fuelType}_status`];
      const previousStatus = previous[`${fuelType}_status`];

      // Топливо исчезло
      if (previousStatus === true && currentStatus === false) {
        events.push({
          station_id: stationId,
          event_type: 'fuel_disappeared',
          fuel_type: fuelType.replace('fuel_', ''),
          detected_at: current.timestamp,
          confidence: 0.9,
          source: 'observation'
        });
      }

      // Топливо появилось (возможная поставка!)
      if (previousStatus === false && currentStatus === true) {
        events.push({
          station_id: stationId,
          event_type: 'fuel_restored',
          fuel_type: fuelType.replace('fuel_', ''),
          detected_at: current.timestamp,
          confidence: 0.85,
          source: 'observation'
        });
      }
    }

    return events;
  }

  // Сохранение события
  async saveEvent(event) {
    const { data, error } = await supabase
      .from('events')
      .insert(event)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  // Обработка всех станций
  async processAllStations() {
    const { data: stations, error } = await supabase
      .from('stations')
      .select('id');

    if (error) throw error;

    console.log(`Обработка ${stations.length} станций на предмет изменений...`);

    for (const station of stations) {
      try {
        const events = await this.detectFuelChanges(station.id);
        
        for (const event of events) {
          await this.saveEvent(event);
          console.log(`Обнаружено событие: ${event.event_type} для станции ${station.id}`);
        }
      } catch (error) {
        console.error(`Ошибка обработки станции ${station.id}:`, error);
      }
    }
  }
}

export default EventDetector;