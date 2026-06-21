import type { VisualDiffReport, VisualDiffRouteReport } from '../../src/lib/types';
import { buildFixtureVisualDiffReport } from '../support/mock-bridge';

function routeTestId(path: string) {
  return `report-route${path.replace(/\//g, '-') || '-root'}`;
}

function buildPassingVisualDiffReport(): VisualDiffReport {
  const report = buildFixtureVisualDiffReport();

  return {
    ...report,
    id: 'report-cypress-all-passing-fixture',
    changedRoutes: 0,
    routes: report.routes.map((route) => ({
      ...route,
      status: 'passed' as const,
      mismatchPixels: 0,
      mismatchRatio: 0,
      afterImage: route.beforeImage,
      diffImage: route.beforeImage,
    })),
  };
}

function buildErrorVisualDiffReport(): VisualDiffReport {
  const report = buildFixtureVisualDiffReport();
  const erroredRoute: VisualDiffRouteReport = {
    ...report.routes[0],
    id: 'GET:/checkout:error',
    path: '/checkout',
    urlPath: '/checkout',
    status: 'error',
    mismatchPixels: 0,
    mismatchRatio: 0,
    error: 'Target returned 500 during capture',
  };

  return {
    ...report,
    id: 'report-cypress-error-fixture',
    changedRoutes: 0,
    totalRoutes: 1,
    routes: [erroredRoute],
  };
}

describe('Visual comparison report', () => {
  beforeEach(() => {
    cy.fixture('visual-diff-expectations').as('expectations');
    cy.installMockBridge();
  });

  it('renders baseline, current, and diff frames after running visual diff', () => {
    cy.runVisualDiff();

    cy.get('[data-testid="empty-report"]').should('not.exist');
    cy.get('[data-testid="report-route-strip"]').should('be.visible');
    cy.get('[data-testid="screenshot-baseline"]').should('be.visible');
    cy.get('[data-testid="screenshot-current"]').should('be.visible');
    cy.get('[data-testid="screenshot-diff"]').should('be.visible');

    cy.get('[data-testid="screenshot-baseline"] img')
      .should('have.attr', 'src')
      .and('include', 'data:image/png');
    cy.get('[data-testid="screenshot-current"] img')
      .should('have.attr', 'src')
      .and('include', 'data:image/png');
    cy.get('[data-testid="screenshot-diff"] img')
      .should('have.attr', 'src')
      .and('include', 'data:image/png');
  });

  it('shows expected changed route count in the footer', function () {
    const expectations = this.expectations as {
      changedRoutes: number;
      totalRoutes: number;
    };

    cy.runVisualDiff();
    cy.get('[data-testid="diff-footer-count"]').should(
      'contain.text',
      `${expectations.changedRoutes}/${expectations.totalRoutes} routes changed`,
    );
  });

  it('marks changed and unchanged routes in the route strip', function () {
    const expectations = this.expectations as {
      changedPaths: string[];
      unchangedPaths: string[];
    };

    cy.runVisualDiff();

    for (const path of expectations.changedPaths) {
      cy.get(`[data-testid="${routeTestId(path)}"]`).should('have.class', 'failed');
    }

    for (const path of expectations.unchangedPaths) {
      cy.get(`[data-testid="${routeTestId(path)}"]`).should('have.class', 'passed');
    }
  });

  it('switches screenshots when selecting another route', () => {
    cy.runVisualDiff();

    cy.get(`[data-testid="${routeTestId('/')}"]`).should('have.class', 'selected');

    cy.get(`[data-testid="${routeTestId('/pricing')}"]`).click();
    cy.get(`[data-testid="${routeTestId('/pricing')}"]`).should('have.class', 'selected');
    cy.get('[data-testid="screenshot-baseline"]').contains('/pricing').should('be.visible');
    cy.get('[data-testid="screenshot-diff"]').contains('/pricing').should('be.visible');
  });

  it('updates status messaging after a diff with changes', function () {
    const expectations = this.expectations as { changedRoutes: number; totalRoutes: number };

    cy.runVisualDiff();
    cy.contains(
      `${expectations.changedRoutes} of ${expectations.totalRoutes} routes changed.`,
    ).should('be.visible');
    cy.contains('Needs review').should('be.visible');
  });

  it('captures several changed UI routes with distinct diff evidence', () => {
    const changedRoutes = [
      { path: '/', ratio: '8.00%', pixels: '1,200 changed pixels' },
      { path: '/pricing', ratio: '9.00%', pixels: '1,350 changed pixels' },
      { path: '/dashboard/settings/auth0', ratio: '10.00%', pixels: '1,500 changed pixels' },
    ];

    cy.runVisualDiff();

    for (const route of changedRoutes) {
      cy.get(`[data-testid="${routeTestId(route.path)}"]`)
        .should('have.class', 'failed')
        .and('contain.text', route.ratio)
        .click();
      cy.get('[data-testid="screenshot-diff"]').should('contain.text', route.pixels);

      cy.get('[data-testid="screenshot-baseline"] img')
        .should('have.attr', 'src')
        .then((baselineSrc) => {
          cy.get('[data-testid="screenshot-current"] img')
            .should('have.attr', 'src')
            .should((currentSrc) => {
              expect(currentSrc).not.to.equal(baselineSrc);
            });
          cy.get('[data-testid="screenshot-diff"] img')
            .should('have.attr', 'src')
            .should((diffSrc) => {
              expect(diffSrc).not.to.equal(baselineSrc);
            });
        });
    }
  });

  it('shows capture progress while visual diff is running', () => {
    cy.installMockBridge({ visualDiffDelayMs: 2000 });

    cy.runVisualDiff();

    cy.get('[data-testid="run-visual-diff"]').should('be.disabled');
    cy.get('[data-testid="empty-report"]').should('contain.text', 'Capturing report');
    cy.get('[data-testid="diff-footer-count"]').should('contain.text', 'Capturing');
    cy.contains('Capturing baseline and target pages').should('be.visible');
    cy.get('[data-testid="screenshot-baseline"]').should('not.exist');
  });

  it('surfaces report viewport, branch, url, and screenshot metadata', () => {
    cy.runVisualDiff();

    cy.contains('6 captured routes at 1280x900').should('be.visible');
    cy.get('.comparison-header').within(() => {
      cy.contains('main').should('be.visible');
      cy.contains('feature/auth0-preview-callbacks').should('be.visible');
    });

    cy.get('[data-testid="screenshot-baseline"]').within(() => {
      cy.contains('http://127.0.0.1:3201/').should('be.visible');
      cy.contains('Baseline').should('be.visible');
      cy.contains('main').should('be.visible');
      cy.get('img').should('have.attr', 'alt', 'Baseline screenshot for /');
    });

    cy.get('[data-testid="screenshot-current"]').within(() => {
      cy.contains('http://127.0.0.1:3202/').should('be.visible');
      cy.contains('Current').should('be.visible');
      cy.contains('feature/auth0-preview-callbacks').should('be.visible');
      cy.get('img').should('have.attr', 'alt', 'Current screenshot for /');
    });

    cy.get('[data-testid="screenshot-diff"]').within(() => {
      cy.contains('/').should('be.visible');
      cy.contains('Diff').should('be.visible');
      cy.contains('1,200 changed pixels').should('be.visible');
      cy.get('img').should('have.attr', 'alt', 'Diff screenshot for /');
    });
  });

  it('updates mismatch percentages and changed pixels for the selected changed route', () => {
    cy.runVisualDiff();

    cy.get(`[data-testid="${routeTestId('/')}"]`).should('contain.text', '8.00%');
    cy.get(`[data-testid="${routeTestId('/pricing')}"]`)
      .should('contain.text', '9.00%')
      .click();

    cy.get(`[data-testid="${routeTestId('/pricing')}"]`).should('have.class', 'selected');
    cy.get('[data-testid="screenshot-baseline"]').should(
      'contain.text',
      'http://127.0.0.1:3201/pricing',
    );
    cy.get('[data-testid="screenshot-current"]').should(
      'contain.text',
      'http://127.0.0.1:3202/pricing',
    );
    cy.get('[data-testid="screenshot-diff"]').should('contain.text', '1,350 changed pixels');
  });

  it('uses captured concrete URLs for parameterized routes', () => {
    cy.runVisualDiff();

    cy.get(`[data-testid="${routeTestId('/projects/:projectId')}"]`)
      .should('contain.text', 'passed')
      .click();

    cy.get('[data-testid="screenshot-baseline"]').should(
      'contain.text',
      'http://127.0.0.1:3201/projects/project_alpha',
    );
    cy.get('[data-testid="screenshot-current"]').should(
      'contain.text',
      'http://127.0.0.1:3202/projects/project_alpha',
    );
    cy.get('[data-testid="screenshot-diff"]').should('contain.text', '/projects/:projectId');
    cy.get('[data-testid="screenshot-diff"]').should('contain.text', '0 changed pixels');
  });

  it('renders a completed report when every captured route matches', () => {
    const report = buildPassingVisualDiffReport();
    cy.installMockBridge({ report });

    cy.runVisualDiff();

    cy.contains(`${report.totalRoutes} routes captured with no visual differences.`).should(
      'be.visible',
    );
    cy.contains('Completed').should('be.visible');
    cy.get('[data-testid="diff-footer-count"]').should(
      'contain.text',
      `0/${report.totalRoutes} routes changed`,
    );
    cy.get('[data-testid="report-route-strip"] [data-testid^="report-route"]').should(
      'have.length',
      report.totalRoutes,
    );
    cy.get('[data-testid="report-route-strip"] [data-testid^="report-route"]').each(($route) => {
      cy.wrap($route).should('have.class', 'passed').and('not.have.class', 'failed');
    });
  });

  it('renders capture errors instead of broken screenshot images', () => {
    cy.installMockBridge({ report: buildErrorVisualDiffReport() });

    cy.runVisualDiff();

    cy.get(`[data-testid="${routeTestId('/checkout')}"]`)
      .should('have.class', 'error')
      .and('contain.text', 'error');
    cy.get('[data-testid="screenshot-baseline"]').within(() => {
      cy.contains('Target returned 500 during capture').should('be.visible');
      cy.get('img').should('not.exist');
    });
    cy.get('[data-testid="screenshot-current"]').within(() => {
      cy.contains('Target returned 500 during capture').should('be.visible');
      cy.get('img').should('not.exist');
    });
    cy.get('[data-testid="screenshot-diff"]').within(() => {
      cy.contains('Target returned 500 during capture').should('be.visible');
      cy.get('img').should('not.exist');
    });
  });
});
