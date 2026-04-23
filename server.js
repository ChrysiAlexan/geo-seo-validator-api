const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;

// Fetch a URL and return the HTML
function fetchUrl(urlStr) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const client = parsed.protocol === 'https:' ? https : http;
    const req = client.get(urlStr, { 
      headers: { 
        'User-Agent': 'Mozilla/5.0 (compatible; GEOValidator/1.0; +https://geo-validator.org)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      timeout: 10000 
    }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (redirectUrl.startsWith('/')) redirectUrl = parsed.origin + redirectUrl;
        fetchUrl(redirectUrl).then(resolve).catch(reject);
        return;
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ html: data, statusCode: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

// Fetch robots.txt
function fetchRobots(urlStr) {
  return new Promise((resolve) => {
    try {
      const parsed = new URL(urlStr);
      const robotsUrl = parsed.origin + '/robots.txt';
      const client = parsed.protocol === 'https:' ? https : http;
      const req = client.get(robotsUrl, { timeout: 5000 }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });
      req.on('error', () => resolve(''));
      req.on('timeout', () => { req.destroy(); resolve(''); });
    } catch(e) { resolve(''); }
  });
}

// Analyze the HTML and return pillar scores
function analyze(html, url, robotsTxt) {
  const lower = html.toLowerCase();
  
  // Helper: count occurrences
  const has = (str) => lower.includes(str.toLowerCase());
  const count = (str) => (lower.match(new RegExp(str.toLowerCase(), 'g')) || []).length;

  // ===== PILLAR 1: Semantic HTML =====
  const hasArticle = has('<article') || has('<article>');
  const hasSection = has('<section') || has('<section>');
  const hasNav = has('<nav') || has('<nav>');
  const hasMain = has('<main') || has('<main>');
  const hasFooter = has('<footer') || has('<footer>');
  const h1Count = count('<h1');
  const h2Count = count('<h2');
  const h3Count = count('<h3');
  const hasGoodHeadings = h1Count >= 1 && h2Count >= 1;
  const hasSemanticNav = hasNav && hasMain;
  const semanticScore = [hasArticle || hasSection, hasGoodHeadings, hasSemanticNav, hasFooter];

  // ===== PILLAR 2: Structured Data =====
  const hasJsonLd = has('application/ld+json');
  const hasMicrodata = has('itemscope') || has('itemtype');
  const hasOG = has('og:title') || has('og:description');
  const hasTwitter = has('twitter:card') || has('twitter:title');
  const structuredScore = [hasJsonLd || hasMicrodata, hasJsonLd, hasOG, hasTwitter];

  // ===== PILLAR 3: Metadata & Freshness =====
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/is);
  const titleText = titleMatch ? titleMatch[1].trim() : '';
  const titleGood = titleText.length > 0 && titleText.length <= 60;
  
  const descMatch = html.match(/meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i) 
                 || html.match(/meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["']/i);
  const descText = descMatch ? descMatch[1] : '';
  const descGood = descText.length >= 100 && descText.length <= 160;
  
  const hasCanonical = has('rel="canonical"') || has("rel='canonical'");
  const hasDateMod = has('datemodified') || has('datepublished') || has('article:modified_time') || has('article:published_time');
  const metaScore = [titleGood, descGood, hasCanonical, hasDateMod];

  // ===== PILLAR 4: Content Authority =====
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  const bodyText = bodyMatch ? bodyMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ') : '';
  const wordCount = bodyText.split(/\s+/).filter(w => w.length > 2).length;
  
  const externalLinks = (html.match(/href=["']https?:\/\//g) || []).length;
  const hasStats = /\d+%|\d+\.\d+|\$\d+|\d{4,}/.test(bodyText);
  const hasByline = has('author') || has('byline') || has('written by') || has('posted by');
  const authorityScore = [externalLinks >= 3, hasStats, externalLinks >= 5, hasByline];

  // ===== PILLAR 5: Answer Capsules =====
  const hasFaq = has('faq') || has('frequently asked') || has('questions and answers');
  const hasFaqSchema = has('faqpage') || has('question');
  const hasDefinitions = has('<dt') || has('<dd') || has('definition') || has('what is');
  const hasSummary = has('summary') || has('tl;dr') || has('key takeaway') || has('in short') || has('in brief');
  const capsuleScore = [hasFaq || hasFaqSchema, hasDefinitions, hasSummary, h2Count >= 3];

  // ===== PILLAR 6: Entity Clarity =====
  const hasSchemaName = has('"name"') || has('"@type"');
  const hasAddress = has('address') || has('location') || has('postalcode');
  const hasPhone = has('telephone') || has('phone') || has('tel:');
  const hasOrgSchema = has('organization') || has('localbusiness') || has('person');
  const entityScore = [hasSchemaName, hasAddress || hasPhone, hasOrgSchema, h1Count === 1];

  // ===== PILLAR 7: E-E-A-T Signals =====
  const hasAbout = has('about us') || has('about me') || has('/about');
  const hasPrivacy = has('privacy policy') || has('privacy-policy') || has('/privacy');
  const isHttps = url.startsWith('https');
  const hasCredentials = has('experience') || has('expertise') || has('certified') || has('years of experience');
  const eeatScore = [hasByline, isHttps, hasPrivacy || hasAbout, hasCredentials];

  // ===== PILLAR 8: AI Crawlability =====
  const robotsLower = robotsTxt.toLowerCase();
  const allowsGPTBot = !robotsLower.includes('user-agent: gptbot') || !robotsLower.includes('disallow: /');
  const allowsClaudeBot = !robotsLower.includes('user-agent: claudebot') || !robotsLower.includes('disallow: /');
  const noJsOnly = has('<noscript') || !has('__next') || bodyText.length > 500;
  const hasRobotsTxt = robotsTxt.length > 10;
  const crawlScore = [allowsGPTBot, allowsClaudeBot, noJsOnly, hasRobotsTxt];

  // ===== PILLAR 9: Content Depth =====
  const goodWordCount = wordCount >= 800;
  const hasMultipleH2 = h2Count >= 3;
  const hasImages = count('<img') >= 2;
  const hasLists = has('<ul') || has('<ol') || has('<li');
  const depthScore = [goodWordCount, hasMultipleH2, hasImages, hasLists];

  // ===== PILLAR 10: Citation Readiness =====
  const hasTables = has('<table');
  const hasListsForData = (count('<li') >= 5);
  const objectiveTone = !has('we are the best') && !has('number one') && !has('buy now') && !has('order today');
  const shortParas = true; // Hard to measure precisely
  const citationScore = [hasTables || hasListsForData, objectiveTone, hasLists, h2Count >= 2];

  // Build results
  const pillars = [
    { id: 'semantic_html', name: 'Semantic HTML', weight: 3, checks: semanticScore },
    { id: 'structured_data', name: 'Structured Data', weight: 3, checks: structuredScore },
    { id: 'metadata_freshness', name: 'Metadata & Freshness', weight: 3, checks: metaScore },
    { id: 'content_authority', name: 'Content Authority', weight: 2, checks: authorityScore },
    { id: 'answer_capsules', name: 'Answer Capsules', weight: 3, checks: capsuleScore },
    { id: 'entity_clarity', name: 'Entity Clarity', weight: 2, checks: entityScore },
    { id: 'eeat_signals', name: 'E-E-A-T Signals', weight: 2, checks: eeatScore },
    { id: 'ai_crawlability', name: 'AI Crawlability', weight: 2, checks: crawlScore },
    { id: 'content_depth', name: 'Content Depth', weight: 2, checks: depthScore },
    { id: 'citation_readiness', name: 'Citation Readiness', weight: 3, checks: citationScore },
  ];

  let totalScore = 0, totalMax = 0;
  const pillarResults = {};
  
  pillars.forEach(p => {
    const score = p.checks.reduce((sum, c) => sum + (c ? p.weight : 0), 0);
    const maxScore = p.weight * p.checks.length;
    totalScore += score;
    totalMax += maxScore;
    pillarResults[p.id] = {
      score, maxScore, checks: p.checks,
      passing: (score / maxScore) >= 0.70,
      percentage: Math.round((score / maxScore) * 100)
    };
  });

  return {
    url,
    overallScore: Math.round((totalScore / totalMax) * 100),
    pillarResults,
    meta: {
      title: titleText,
      titleLength: titleText.length,
      descriptionLength: descText.length,
      wordCount,
      h1Count, h2Count, h3Count,
      hasJsonLd, hasOG, hasTwitter,
      isHttps,
      externalLinks
    }
  };
}

// HTTP Server
const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url.startsWith('/analyze')) {
    const urlParam = new URL(req.url, 'http://localhost').searchParams.get('url');
    
    if (!urlParam) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing url parameter' }));
      return;
    }

    let targetUrl = urlParam;
    if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;

    try {
      console.log(`Analyzing: ${targetUrl}`);
      const startTime = Date.now();
      
      const [pageData, robotsTxt] = await Promise.all([
        fetchUrl(targetUrl),
        fetchRobots(targetUrl)
      ]);
      
      const fetchTime = Date.now() - startTime;
      const results = analyze(pageData.html, targetUrl, robotsTxt);
      results.meta.fetchTimeMs = fetchTime;
      results.meta.statusCode = pageData.statusCode;
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(results));
    } catch (err) {
      console.error(`Error analyzing ${targetUrl}:`, err.message);
      
      // Handle network errors gracefully
      if (err.message.includes('ENOTFOUND') || err.message.includes('ECONNREFUSED')) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          error: 'Network error: Unable to reach the URL. The server may be down or unreachable.',
          details: err.message 
        }));
      } else if (err.message.includes('Timeout')) {
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          error: 'Timeout: The page took too long to load (>10 seconds).',
          details: err.message 
        }));
      } else {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
    return;
  }

  // Health check
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', version: '1.0' }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`GEO Validator API running on port ${PORT}`);
  console.log(`Test: http://localhost:${PORT}/analyze?url=example.com`);
});
