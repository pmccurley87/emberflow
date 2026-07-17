import { inspectorSectionsFor } from './Inspector';
import { it, expect } from 'vitest';

it('simple register folds schemas into Details; technical keeps them top-level', () => {
  expect(inspectorSectionsFor('simple')).toEqual({ schemasInDetails: true });
  expect(inspectorSectionsFor('technical')).toEqual({ schemasInDetails: false });
});
