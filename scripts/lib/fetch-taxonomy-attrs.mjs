/**
 * Y2KASE — Taxonomy Attribute Fetcher
 *
 * Queries the Shopify Admin GraphQL API for all taxonomy attributes
 * (and their valid value GIDs) for the Mobile Phone Cases category
 * (gid://shopify/TaxonomyCategory/el-4-8-4-2), then writes the result
 * to .cache/taxonomy-attrs-cache.json.
 *
 * Run once before the first import, and re-run whenever Shopify updates
 * their product taxonomy:
 *
 *   node scripts/lib/fetch-taxonomy-attrs.mjs
 *
 * The cache is read at import time by category-metafields.mjs to map
 * classification signals to taxonomy value GIDs for productSet metafields.
 */

import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { shopifyGql } from '../shopify-client.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CATEGORY_GID = 'gid://shopify/TaxonomyCategory/el-4-8-4-2';
const CACHE_PATH   = resolve(__dirname, '../../.cache/taxonomy-attrs-cache.json');

// Query by search — node(id:) doesn't resolve TaxonomyCategory slug GIDs.
// The live schema only exposes id + name on TaxonomyChoiceListAttribute and
// TaxonomyValue (no handle field), so we index values by their display name.
const QUERY = /* GraphQL */ `
  query GetPhoneCaseTaxonomyAttrs {
    taxonomy {
      categories(search: "Mobile Phone Cases", first: 5) {
        edges {
          node {
            id
            name
            fullName
            attributes(first: 50) {
              edges {
                node {
                  __typename
                  ... on TaxonomyChoiceListAttribute {
                    id
                    name
                    values(first: 150) {
                      edges {
                        node {
                          id
                          name
                        }
                      }
                    }
                  }
                  ... on TaxonomyAttribute        { id }
                  ... on TaxonomyMeasurementAttribute { id }
                }
              }
            }
          }
        }
      }
    }
  }
`;

async function main() {
  console.log(`Fetching taxonomy attributes for ${CATEGORY_GID} …`);

  const result = await shopifyGql(QUERY, {});

  // shopifyGql returns the full GraphQL response — unwrap the data envelope
  const data  = result?.data ?? result;

  // Find the exact category by ID among search results
  const edges = data?.taxonomy?.categories?.edges ?? [];
  let catNode = edges.find(e => e.node?.id === CATEGORY_GID)?.node;

  // Fallback: take the first result named "Mobile Phone Cases" if GID didn't match
  if (!catNode) {
    catNode = edges.find(e =>
      e.node?.name?.toLowerCase() === 'mobile phone cases' ||
      e.node?.fullName?.toLowerCase().includes('mobile phone cases')
    )?.node;
  }

  if (!catNode) {
    console.error('Mobile Phone Cases category not found in taxonomy search results.');
    console.error('Search returned:', edges.map(e => `${e.node?.id} — ${e.node?.fullName}`));
    process.exit(1);
  }

  console.log(`Category: ${catNode.fullName} (${catNode.id})`);
  const node = catNode;

  // Normalise into a flat map keyed by slugified attribute name
  // (live schema exposes id + name only — no handle field on attributes/values).
  const attrs = {};
  for (const edge of (node.attributes?.edges ?? [])) {
    const a = edge.node;
    if (!a?.id) continue;

    const slug  = slugify(a.name ?? '');
    const entry = {
      id:       a.id,
      name:     a.name ?? '',
      handle:   slug,
      typename: a.__typename,
      values:   {},
    };

    if (a.__typename === 'TaxonomyChoiceListAttribute') {
      for (const ve of (a.values?.edges ?? [])) {
        const v = ve.node;
        // Index by display name (exact match used by category-metafields.mjs)
        entry.values[v.name] = v.id;
      }
    }

    attrs[slug] = entry;
  }

  function slugify(s) {
    return s.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  const cache = {
    fetchedAt:  new Date().toISOString(),
    categoryId: CATEGORY_GID,
    attributes: attrs,
  };

  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), 'utf-8');
  console.log(`✓ Cached ${Object.keys(attrs).length} attributes → ${CACHE_PATH}`);

  // Print a summary for review
  for (const [handle, attr] of Object.entries(attrs)) {
    const valueCount = Object.keys(attr.values).length / 2; // de-dup name+suffix
    console.log(`  ${handle} (${attr.typename}) — ${valueCount} values`);
  }
}

main().catch(err => {
  console.error('fetch-taxonomy-attrs failed:', err.message);
  process.exit(1);
});
