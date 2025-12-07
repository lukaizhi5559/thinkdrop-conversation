/**
 * Context Extraction Service
 * Lightweight fact extraction from conversation messages
 */

class ContextExtractor {
  constructor() {
    // Fact extraction patterns (lightweight, regex-based)
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
   * Extract all context from text (main entry point)
   * Simplified to use only regex-based fact extraction
   */
  async extract(text, sessionId) {
    console.log(`🔍 [EXTRACTOR] Extracting context from: "${text.substring(0, 50)}..."`);
    
    // Quick fact extraction (synchronous, fast, no external calls)
    const facts = this.extractQuickFacts(text);
    
    console.log(`✅ [EXTRACTOR] Extracted ${facts.length} facts, 0 entities`);
    
    return {
      facts,
      entities: [], // No entity extraction
      sessionId,
      extractedAt: new Date().toISOString(),
      method: 'regex_patterns'
    };
  }
}

module.exports = new ContextExtractor();
