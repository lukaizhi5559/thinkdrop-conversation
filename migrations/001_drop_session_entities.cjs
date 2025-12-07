/**
 * Migration: Drop session_entities table
 * 
 * This migration removes the session_entities table and related indexes
 * as entity extraction has been removed from the conversation service.
 * 
 * Run this migration once to clean up existing databases.
 */

const Database = require('duckdb').Database;
const path = require('path');

async function migrate() {
  // Try multiple possible database locations
  const possiblePaths = [
    process.env.CONVERSATION_DB_PATH,
    path.join(__dirname, '..', '..', '..', 'data', 'conversation.duckdb'),
    path.join(process.env.HOME || process.env.USERPROFILE, '.thinkdrop', 'data', 'conversation.duckdb')
  ].filter(Boolean);
  
  let dbPath = null;
  const fs = require('fs');
  
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      dbPath = p;
      break;
    }
  }
  
  if (!dbPath) {
    console.log('⚠️  [MIGRATION] No existing database found. Migration not needed.');
    console.log('   Checked paths:');
    possiblePaths.forEach(p => console.log(`   - ${p}`));
    return;
  }
  
  console.log('🔄 [MIGRATION] Starting migration: Drop session_entities table');
  console.log(`📁 [MIGRATION] Database: ${dbPath}`);
  
  return new Promise((resolve, reject) => {
    const db = new Database(dbPath, (err) => {
      if (err) {
        console.error('❌ [MIGRATION] Failed to connect to database:', err);
        return reject(err);
      }
      
      console.log('✅ [MIGRATION] Connected to database');
      
      const connection = db.connect();
      
      // Drop indexes first
      const dropIndexesSQL = `
        DROP INDEX IF EXISTS idx_session_entities_session;
        DROP INDEX IF EXISTS idx_session_entities_type;
      `;
      
      connection.exec(dropIndexesSQL, (err) => {
        if (err) {
          console.warn('⚠️  [MIGRATION] Failed to drop indexes (may not exist):', err.message);
          // Continue anyway - indexes might not exist
        } else {
          console.log('✅ [MIGRATION] Dropped entity indexes');
        }
        
        // Drop table
        const dropTableSQL = `DROP TABLE IF EXISTS session_entities`;
        
        connection.exec(dropTableSQL, (err) => {
          if (err) {
            console.error('❌ [MIGRATION] Failed to drop session_entities table:', err);
            db.close();
            return reject(err);
          }
          
          console.log('✅ [MIGRATION] Dropped session_entities table');
          
          // Verify table is gone
          connection.all(
            `SELECT table_name FROM information_schema.tables WHERE table_name = 'session_entities'`,
            (err, rows) => {
              if (err) {
                console.warn('⚠️  [MIGRATION] Could not verify table deletion:', err.message);
              } else if (rows && rows.length === 0) {
                console.log('✅ [MIGRATION] Verified: session_entities table removed');
              } else {
                console.warn('⚠️  [MIGRATION] Table may still exist');
              }
              
              db.close();
              console.log('✅ [MIGRATION] Migration complete!');
              resolve();
            }
          );
        });
      });
    });
  });
}

// Run migration if called directly
if (require.main === module) {
  migrate()
    .then(() => {
      console.log('✅ Migration successful');
      process.exit(0);
    })
    .catch((error) => {
      console.error('❌ Migration failed:', error);
      process.exit(1);
    });
}

module.exports = { migrate };
