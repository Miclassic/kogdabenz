// supabase/setup.js
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'fs';
import dotenv from 'dotenv';

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

async function setupDatabase() {
  console.log('🚀 Настройка базы данных...\n');

  const schema = readFileSync('./supabase/schema.sql', 'utf8');
  
  const queries = schema
    .split(';')
    .map(q => q.trim())
    .filter(q => q.length > 0);

  for (const query of queries) {
    try {
      const { error } = await supabase.rpc('exec_sql', { sql: query });
      if (error) {
        console.error('Ошибка выполнения запроса:', error);
      } else {
        console.log('✓ Запрос выполнен успешно');
      }
    } catch (err) {
      console.error('Ошибка:', err.message);
    }
  }

  console.log('\n✅ База данных настроена!');
  console.log('\nСледующие шаги:');
  console.log('1. Запустите сборщик: npm run collect');
  console.log('2. Подождите несколько дней для накопления данных');
  console.log('3. Запустите полную систему: npm start');
}

setupDatabase().catch(console.error);