import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { searchDatabaseObjectsSchema } from '../../tools/search-objects.js';
import { getToolsForSource } from '../tool-metadata.js';
import { ConnectorManager } from '../../connectors/manager.js';
import { getToolRegistry } from '../../tools/registry.js';

vi.mock('../../connectors/manager.js');
vi.mock('../../tools/registry.js');

describe('tool metadata', () => {
  const mockGetToolRegistry = vi.mocked(getToolRegistry);

  beforeEach(() => {
    vi.mocked(ConnectorManager.getAvailableSourceIds).mockReturnValue(['default']);
    vi.mocked(ConnectorManager.getSourceConfig).mockReturnValue({
      id: 'default',
      type: 'postgres',
      dsn: 'postgres://example',
    } as any);
    mockGetToolRegistry.mockReturnValue({
      getEnabledToolConfigs: vi.fn().mockReturnValue([
        { name: 'search_objects' },
      ]),
    } as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('accepts function object type in search_objects schema', () => {
    const parsed = searchDatabaseObjectsSchema.object_type.safeParse('function');
    expect(parsed.success).toBe(true);
  });

  it('includes table filter parameter in search_objects metadata', () => {
    const tools = getToolsForSource('default');
    const searchObjects = tools.find((tool) => tool.name === 'search_objects');

    expect(searchObjects).toBeDefined();
    expect(searchObjects?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'table',
          required: false,
          description: expect.stringContaining('column/index only'),
        }),
      ])
    );
  });

  it('documents function support in search_objects metadata description', () => {
    const tools = getToolsForSource('default');
    const searchObjects = tools.find((tool) => tool.name === 'search_objects');

    expect(searchObjects?.description).toContain('functions');
  });
});
