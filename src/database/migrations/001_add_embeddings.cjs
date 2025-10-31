/**
 * Migration: Add embedding column to conversation_messages
 */

async function up(connection) {
  return new Promise((resolve, reject) => {
    const sql = `
      ALTER TABLE conversation_messages 
      ADD COLUMN IF NOT EXISTS embedding TEXT
    `;
    
    connection.exec(sql, (err) => {
      if (err) {
        console.error('❌ [MIGRATION] Failed to add embedding column:', err);
        return reject(err);
      }
      
      console.log('✅ [MIGRATION] Added embedding column to conversation_messages');
      resolve();
    });
  });
}

async function down(connection) {
  return new Promise((resolve, reject) => {
    const sql = `
      ALTER TABLE conversation_messages 
      DROP COLUMN IF EXISTS embedding
    `;
    
    connection.exec(sql, (err) => {
      if (err) {
        console.error('❌ [MIGRATION] Failed to drop embedding column:', err);
        return reject(err);
      }
      
      console.log('✅ [MIGRATION] Dropped embedding column from conversation_messages');
      resolve();
    });
  });
}

module.exports = { up, down };
