import { describe, expect, test } from 'bun:test'
import { buildAppVersion } from './appVersion'

describe('buildAppVersion', () => {
  test('release builds show the tag alone', () => {
    expect(
      buildAppVersion({ tag: 'v1.2.3', branch: null, sha: null, isRelease: true }),
    ).toBe('v1.2.3')
    // Extra git facts do not leak into a release version.
    expect(
      buildAppVersion({ tag: 'v1.2.3', branch: 'main', sha: 'abc1234', isRelease: true }),
    ).toBe('v1.2.3')
  })

  test('preview builds are tag-branch-sha', () => {
    expect(
      buildAppVersion({ tag: 'v1.2.3', branch: 'main', sha: 'abc1234', isRelease: false }),
    ).toBe('v1.2.3-main-abc1234')
    expect(
      buildAppVersion({
        tag: 'v1.2.3',
        branch: 'feat/cf-ci-release',
        sha: 'abc1234',
        isRelease: false,
      }),
    ).toBe('v1.2.3-feat/cf-ci-release-abc1234')
  })

  test('a checkout with no reachable tag still identifies the commit', () => {
    expect(
      buildAppVersion({ tag: null, branch: 'main', sha: 'abc1234', isRelease: false }),
    ).toBe('dev-abc1234')
  })

  test('no git facts at all degrades to dev', () => {
    expect(buildAppVersion({ tag: null, branch: null, sha: null, isRelease: false })).toBe('dev')
    expect(buildAppVersion({ tag: null, branch: null, sha: null, isRelease: true })).toBe('dev')
  })
})
