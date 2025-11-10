# Adnet Agent

The Adnet Agent is a publisher-side component that manages ad display and event tracking. It consists of:

1. **Server Component** - Express middleware that batches events into a hash chain
2. **Client Component** - Browser script that renders ads and tracks interactions

## Architecture

### Hash Chain for Event Batching

The agent maintains a hash chain of events (views and clicks) before posting them to campaign contracts. This provides:

- **Cost Efficiency**: Batch transactions reduce gas costs
- **Proof of Stake**: Chain integrity prevents fake events
- **Threshold Control**: Configurable batching based on trust level

Each event is hashed with the previous hash, creating a verifiable chain:

```
Event 1 -> Hash1 (includes previousHash: 0x000...)
Event 2 -> Hash2 (includes previousHash: Hash1)
Event 3 -> Hash3 (includes previousHash: Hash2)
...
```

When the threshold is reached (default: 5 for testing, 1000+ for production), the entire chain is posted to the appropriate campaign contracts.

## Server Component

### Installation

```javascript
import AdnetAgent from '@geistm/adnet-agent';

const agent = new AdnetAgent({
  domain: 'publisher.com',        // Publisher domain
  threshold: 5,                   // Events before posting to contract
  factoryUrl: 'https://adnet.blackfire.pro'
});

await agent.attach(app); // Attach to Express app
```

### API Endpoints

All endpoints are mounted at `/.well-known/epistery/agent/adnet`:

#### `GET /client.js`
Serves the client-side JavaScript

#### `GET /campaigns`
List available campaigns

**Response:**
```json
{
  "status": "success",
  "campaigns": [...],
  "count": 5
}
```

#### `GET /campaigns/:id`
Get campaign details with promotions

#### `POST /record`
Record view or click event

**Request:**
```json
{
  "campaignId": "campaign-123",
  "promotionId": "promo-456",
  "type": "view",
  "userAddress": "0x..." // optional
}
```

**Response:**
```json
{
  "status": "success",
  "event": {
    "hash": "abc123...",
    "chainIndex": 2
  },
  "chainLength": 3,
  "threshold": 5
}
```

#### `GET /status`
Get hash chain status (for debugging)

#### `POST /flush`
Manually trigger flush to contracts (for testing)

### Hash Chain Structure

```javascript
{
  campaignId: "campaign-123",
  promotionId: "promo-456",
  type: "view",
  timestamp: "2025-11-09T12:00:00.000Z",
  hash: "abc123...",           // SHA256 of event + previousHash
  previousHash: "def456...",   // Hash of previous event
  chainIndex: 2                // Position in chain
}
```

## Client Component

### Usage

Include the client script in your HTML:

```html
<script src="/.well-known/epistery/agent/adnet/client.js"></script>
```

### Ad Placeholders

Add divs with class `adnet-entry` and an optional format class:

```html
<!-- Banner ad (728x90) -->
<div class="adnet-entry adnet-entry-banner"></div>

<!-- Square ad (300x250) -->
<div class="adnet-entry adnet-entry-square"></div>

<!-- Card ad (article-style) -->
<div class="adnet-entry adnet-entry-card"></div>

<!-- Default ad -->
<div class="adnet-entry"></div>
```

### How It Works

1. **Initialization**: Client fetches available campaigns on page load
2. **Ad Selection**: Randomly selects campaign and promotion for each placeholder
3. **Rendering**: Builds HTML with image, title, subtitle, and "Sponsored" label
4. **View Tracking**: Records view event when ad is rendered
5. **Click Tracking**: Records click event then navigates to landing URL

### Event Flow

```
Page Load
  ↓
Client fetches campaigns from agent server
  ↓
Client finds all .adnet-entry divs
  ↓
For each placeholder:
  - Select random campaign
  - Fetch campaign details (promotions)
  - Select random promotion
  - Render ad HTML
  - POST view event to agent server → Added to hash chain
  - Attach click handler
    ↓
User clicks ad
  - POST click event to agent server → Added to hash chain
  - Navigate to landing URL
    ↓
When chain reaches threshold (e.g., 5 events)
  - Agent posts entire chain to campaign contracts
  - Chain is cleared and starts fresh
```

## Integration Example

See `../adnet-demo` for a complete example of a publisher site using the agent.

## Configuration

### Threshold

The threshold determines how many events are batched before posting to contracts:

- **Low (5-10)**: For testing or high-trust publishers
- **Medium (100-500)**: For established publishers
- **High (1000+)**: For maximum efficiency with large traffic

Higher thresholds reduce gas costs but increase risk of lost events if the publisher's server fails.

### Periodic Flush

Set up a periodic flush to post events even if threshold isn't reached:

```javascript
setInterval(() => {
  agent.periodicFlush();
}, 5 * 60 * 1000); // Every 5 minutes
```

## Proof of Stake

The hash chain provides cryptographic proof that events are legitimate:

1. Each event hash includes the previous hash
2. Hashes are generated server-side with timestamps
3. Factory can verify chain integrity when events are posted
4. Broken chains indicate tampering

Future enhancement: Publishers stake tokens to participate. Fraudulent activity results in stake slashing.

## Development

### Testing

1. Start adnet-factory (with test campaigns)
2. Start adnet-demo (with agent configured)
3. Visit demo site and watch console for:
   - Campaign fetching
   - Ad rendering
   - View events being recorded
   - Chain length increasing
   - Automatic flush when threshold reached

### Debug Endpoints

```bash
# Check chain status
curl http://localhost:3009/.well-known/epistery/agent/adnet/status

# Manually trigger flush
curl -X POST http://localhost:3009/.well-known/epistery/agent/adnet/flush
```

## Future Enhancements

- [ ] Smart promotion selection (A/B testing, performance-based)
- [ ] Viewability tracking (only count views when ad is visible)
- [ ] Fraud detection (IP analysis, bot detection)
- [ ] User identification via Epistery identity wallets
- [ ] Publisher staking and reputation system
- [ ] Real-time reporting dashboard
