/**
 * Context Extraction Service
 * Uses Phi4 LLM for intelligent entity and fact extraction
 */

const axios = require('axios');
const crypto = require('crypto');

class ContextExtractor {
  constructor() {
    // Phi4 service configuration
    this.phi4Endpoint = process.env.PHI4_ENDPOINT || 'http://localhost:3003';
    this.phi4ApiKey = process.env.PHI4_API_KEY || 'auto-generated-key-phi4';
    
    // Fact extraction patterns (lightweight fallback for simple cases)
    this.quickFactPatterns = [
      {
        regex: /my (?:favorite|fav) (\w+) is ([\w\s]+?)(?:\.|$|,)/i,
        extract: (match) => ({
          key: `favorite_${match[1]}`,
          value: match[2].trim(),
          confidence: 0.9
        })
      },
      {
        regex: /my name is (\w+)/i,
        extract: (match) => ({
          key: 'user_name',
          value: match[1],
          confidence: 0.95
        })
      }
    ];
  }
  
  /**
   * Extract entities using Phi4's entity.extract endpoint
   */
  async extractEntitiesViaPhi4(text) {
    try {
      const requestId = `ctx_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      
      const response = await axios.post(
        `${this.phi4Endpoint}/entity.extract`,
        {
          version: 'mcp.v1',
          service: 'phi4',
          action: 'entity.extract',
          requestId,
          payload: {
            text,
            // Request specific entity types relevant to context
            entityTypes: ['PERSON', 'ORGANIZATION', 'LOCATION', 'DATE', 'TIME', 'PRODUCT', 'EVENT'],
            options: {
              includeConfidence: true
            }
          }
        },
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': this.phi4ApiKey,  // MCP protocol uses Authorization header
            'X-Service-Name': 'conversation-service',
            'X-Request-ID': requestId
          },
          timeout: 5000 // 5 second timeout
        }
      );
      
      if (response.data?.status === 'ok' && response.data?.data?.entities) {
        return response.data.data.entities.map(entity => ({
          type: this.normalizeEntityType(entity.type),
          value: entity.text || entity.value,
          confidence: entity.confidence || 0.8,
          startPos: entity.start,
          endPos: entity.end
        }));
      }
      
      console.warn('⚠️ [EXTRACTOR] Phi4 returned unexpected format:', response.data);
      return [];
      
    } catch (error) {
      console.error('❌ [EXTRACTOR] Phi4 entity extraction failed:', error.message);
      return []; // Graceful fallback
    }
  }
  
  /**
   * Normalize entity types from Phi4 to our schema
   */
  normalizeEntityType(phi4Type) {
    const typeMap = {
      'PERSON': 'person',
      'ORGANIZATION': 'organization',
      'ORG': 'organization',
      'LOCATION': 'place',
      'LOC': 'place',
      'GPE': 'place', // Geopolitical entity
      'DATE': 'date',
      'TIME': 'time',
      'PRODUCT': 'product',
      'EVENT': 'event',
      'FOOD': 'food',
      'WORK_OF_ART': 'media'
    };
    
    return typeMap[phi4Type] || phi4Type.toLowerCase();
  }
  
  /**
   * Extract facts using lightweight patterns (fast path)
   */
  extractQuickFacts(text) {
    const facts = [];
    
    for (const pattern of this.quickFactPatterns) {
      const match = text.match(pattern.regex);
      if (match) {
        facts.push(pattern.extract(match));
      }
    }
    
    return facts;
  }
  
  /**
   * Extract facts using LLM analysis (for complex cases)
   */
  async extractFactsViaLLM(text, entities) {
    // Use entities to identify potential facts
    const facts = [];
    
    // Pattern: "I love X" where X is an entity
    const loveMatch = text.match(/I (?:love|like|enjoy|prefer) ([\w\s]+?)(?:\.|$|,)/i);
    if (loveMatch) {
      const value = loveMatch[1].trim();
      // Check if this matches an extracted entity
      const matchingEntity = entities.find(e => 
        value.toLowerCase().includes(e.value.toLowerCase())
      );
      
      if (matchingEntity) {
        facts.push({
          key: `likes_${matchingEntity.type}`,
          value: matchingEntity.value,
          confidence: 0.85
        });
      }
    }
    
    // Pattern: "I'm from X" where X is a location
    const fromMatch = text.match(/I(?:'m| am) from ([\w\s]+?)(?:\.|$|,)/i);
    if (fromMatch) {
      const location = fromMatch[1].trim();
      const locationEntity = entities.find(e => 
        e.type === 'place' && location.toLowerCase().includes(e.value.toLowerCase())
      );
      
      if (locationEntity) {
        facts.push({
          key: 'home_location',
          value: locationEntity.value,
          confidence: 0.9
        });
      }
    }
    
    return facts;
  }
  
  /**
   * Extract all context from text (main entry point)
   */
  async extract(text, sessionId) {
    console.log(`🔍 [EXTRACTOR] Extracting context from: "${text.substring(0, 50)}..."`);
    
    try {
      // Step 1: Quick fact extraction (synchronous, fast)
      const quickFacts = this.extractQuickFacts(text);
      
      // Step 2: Entity extraction via Phi4 (async, accurate)
      const entities = await this.extractEntitiesViaPhi4(text);
      
      // Step 3: LLM-based fact extraction using entities
      const llmFacts = await this.extractFactsViaLLM(text, entities);
      
      // Combine facts (deduplicate by key)
      const allFacts = [...quickFacts, ...llmFacts];
      const uniqueFacts = Array.from(
        new Map(allFacts.map(f => [f.key, f])).values()
      );
      
      console.log(`✅ [EXTRACTOR] Extracted ${uniqueFacts.length} facts, ${entities.length} entities`);
      
      return {
        facts: uniqueFacts,
        entities,
        sessionId,
        extractedAt: new Date().toISOString(),
        method: 'phi4_llm' // Track extraction method
      };
      
    } catch (error) {
      console.error('❌ [EXTRACTOR] Extraction failed:', error.message);
      
      // Fallback: return quick facts only
      const quickFacts = this.extractQuickFacts(text);
      return {
        facts: quickFacts,
        entities: [],
        sessionId,
        extractedAt: new Date().toISOString(),
        method: 'fallback'
      };
    }
  }
}

module.exports = new ContextExtractor();
