#!/usr/bin/env node
import 'make-promises-safe'
import yaml from 'js-yaml'
import open from 'open'
import * as fs from 'fs'
import commander from 'safe-commander'
import chalk from 'chalk'
import {collect, filter, map, asArray} from 'iterates/cjs/sync'
import {pipeValue, tuple} from 'iterates'
import inquirer from 'inquirer'
import fetch, {RequestInit} from 'node-fetch'
import {join} from 'path'
import {resolve} from 'url'
import execa from 'execa'
import * as tmp from 'tmp'
import * as R from 'ramda'

const debug = require('debug')('redmine')

type Config = {
  apiKey?: string
  server?: string
  project?: string
  me?: string
  skipCertificateValidation?: boolean
  requireParent?: boolean
  editor?: string
}

type Resource = {id: number}
type NamedResource = {id: number; name: string}

type Issue = {
  id: number
  project: NamedResource
  tracker: NamedResource
  status: NamedResource
  priority: NamedResource
  author?: NamedResource
  assigned_to?: NamedResource
  fixed_version?: NamedResource
  parent?: Resource
  subject: string
  description: string
  start_date: string
  done_ratio: number
  custom_fields: any[]
  created_on: string
  updated_on: string
}

type IssueBody = {
  project_id: number
  tracker_id: number
  status_id?: number
  priority_id?: number
  subject?: string
  description?: string
  category_id?: number
  fixed_version_id?: number
  assigned_to_id?: number
  parent_issue_id?: number
  // custom_fields? - See Custom fields
  watcher_user_ids?: number[]
  is_private?: boolean
  estimated_hours?: number
}

export function compare(
  filter: string | undefined,
  value: undefined | Partial<NamedResource>,
) {
  if (!filter) return true

  const expressions = filter.split('|').map(s => s.trim().toLowerCase())

  return pipeValue(
    expressions,
    map(
      e =>
        e.startsWith('!') ? tuple([e.slice(1), R.not]) : tuple([e, R.identity]),
    ),
    map(([e, cmp]) =>
      R.compose(
        cmp,
        e === 'none'
          ? R.isNil
          : R.either(
              R.compose(
                R.contains(e),
                R.toLower,
                R.defaultTo(''),
                R.prop('name'),
              ),
              R.compose(R.equals(+e), R.prop('id')),
            ),
      ),
    ),
    asArray,
  ).some(cmp => cmp(value as any) as boolean)
}

function loadConfig() {
  const config: Config = {}

  try {
    const file = yaml.safeLoad(
      fs.readFileSync(
        join(process.env.HOME!, 'Library/Preferences/redmine.yaml'),
        'utf8',
      ),
    )
    Object.assign(config, file)
  } catch (e) {
    console.error(e)
  }

  let dir = process.cwd() + '/'
  while (true) {
    try {
      const file = yaml.safeLoad(
        fs.readFileSync(join(dir, '.redmine.yaml'), 'utf8'),
      )
      Object.assign(config, file)
    } catch (e) {}
    dir = resolve(dir, '..')
    if (dir === '/') break
  }

  return config
}

function webUrl(config: Config, appOptions: {server?: string}) {
  const server = appOptions.server || config.server
  if (!server) {
    console.error('Please specify server')
    process.exit(1)
  }
  return server
}

function serverUrl(config: Config, appOptions: {server?: string}) {
  const server = webUrl(config, appOptions)
  const serverWithAuth = server!.replace(
    'https://',
    `https://${config.apiKey}:@`,
  )
  return serverWithAuth
}

function projectUrl(
  config: Config,
  appOptions: {server?: string; project?: string},
) {
  const project = appOptions.project || config.project
  if (!project) {
    console.error('Please specify project')
    process.exit(1)
  }
  const serverWithAuth = serverUrl(config, appOptions)
  return serverWithAuth + '/projects/' + project!
}

function whois(config: Config) {
  if (!config.me) {
    console.error('Please specify me')
    process.exit(1)
  }
  return config.me!
}

function expandMe(config: Config, user: string) {
  if (user !== 'me') return user
  else return whois(config)
}

async function get<T = any>(url: string, init?: RequestInit): Promise<T> {
  debug('get', url)
  const response = await fetch(url, init)
  if (response.status >= 400)
    throw Error(`FetchError: ${response.status} -  ${await response.text()}`)
  return response.json()
}

async function fetchAll<T>(url: string, key: string): Promise<T[]> {
  let offset = 0
  let items: T[] = []
  while (true) {
    const body = await get(`${url}?limit=100&offset=${offset}`)
    items = items.concat(body[key])
    offset += 100
    debug('body.total_count', body.total_count)
    if (body.total_count <= offset) break
  }
  return items
}

async function getTracker(
  serverUrl: string,
  trackerName: string,
): Promise<NamedResource> {
  const {trackers} = await get(`${serverUrl}/trackers.json`)
  const tracker = trackers.find(
    t => t.name.toLowerCase() === trackerName.toLowerCase(),
  )

  if (!tracker) {
    console.error(`Invalid tracker "${trackerName}"`)
    process.exit(1)
  }

  return tracker
}

async function getRelease(
  projectUrl: string,
  releaseName: string,
): Promise<NamedResource> {
  const {versions} = await get(`${projectUrl}/versions.json`)
  const release = versions.find(
    v => v.name.toLowerCase() === releaseName.toLowerCase(),
  )

  if (!release) {
    console.error(`Invalid release "${releaseName}"`)
    process.exit(1)
  }

  return release
}

async function getStatus(
  serverUrl: string,
  statusName: string,
): Promise<NamedResource> {
  const {issue_statuses: statuses} = await get(
    `${serverUrl}/issue_statuses.json`,
  )
  const status = statuses.find(
    s => s.name.toLowerCase() === statusName.toLowerCase(),
  )

  if (!status) {
    console.error(`Invalid status "${statusName}"`)
    process.exit(1)
  }

  return status
}

async function selectParentIssue(projectUrl: string): Promise<number> {
  const allIssues = await fetchAll<Issue>(`${projectUrl}/issues.json`, 'issues')

  const issues = allIssues.filter(i => !i.parent)

  const answers = await inquirer.prompt({
    type: 'list',
    name: 'parent',
    message: 'Select parent task',
    choices: issues.map(issue => ({
      name: `#${issue.id} ${issue.subject}`,
      value: issue.id.toString(),
    })),
  })

  return +answers.parent
}

async function getUser(
  projectUrl: string,
  userName: string,
): Promise<NamedResource> {
  const {memberships} = await get(`${projectUrl}/memberships.json`)
  const membership = memberships.find(m => m.user && m.user.name === userName)

  if (!membership) {
    console.error(`Invalid user "${userName}"`)
    process.exit(1)
  }

  return membership.user
}

async function openInEditor(config: Config, header: string, content: string) {
  const editor =
    config.editor || process.env.VISUAL || process.env.EDITOR || 'vi'
  const [cmd, ...args] = editor.split(' ')

  const tmpFile = tmp.fileSync()
  await fs.writeFileSync(
    tmpFile.fd,
    `${header
      .split('\n')
      .map(line => `; ${line}`)
      .join(';\n')}
; Lines starting with ; are comments and is ignored
;
${content}`,
  )
  await execa(cmd, [...args, tmpFile.name], {stdio: 'inherit'})
  const result = fs
    .readFileSync(tmpFile.fd)
    .toString('utf8')
    .replace(/^;.*((\r?\n)|\r)/gm, '')
  tmpFile.removeCallback()
  return result
}

function main() {
  const config = loadConfig()

  if (config.skipCertificateValidation) {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  }

  const program = commander
    .version(require('../package.json').version, '-v, --version')
    .option('-S, --server <server>', 'address to the Redmine server')
    .option('-P, --project <project>', 'project identifier')

  program
    .command('list')
    .alias('l')
    .description('list open issues')
    .option(
      '-p, --parent-issue <parent issue>',
      'Filter to the specified parent issue',
    )
    .option('-s, --status <status>', 'Filter to the specified statues')
    .option('-r, --release <release>', 'Filter to the specified release')
    .option(
      '-u, --user <user>',
      'Filter to issues assigned to the specified user',
    )
    .option('--me', 'Filter to issues assigned to me')
    .option('-o, --sort <sort>', 'Sort', 'status')
    .option('-g, --group', 'group')
    .action(listCommand)

  program
    .command('show <issue>')
    .alias('s')
    .description('Display details of an issue')
    .action(showCommand)

  program
    .command('open <issue>')
    .alias('o')
    .description('Open issue in a browser')
    .action(openCommand)

  program
    .command('new <title>')
    .alias('n')
    .description('create a new issue')
    .option(
      '-d, --description [description]',
      'Set the description, or open an editor if no value is passed',
    )
    .option(
      '-D, --idescription [description]',
      'Set the description, or open an editor if no value is passed',
    )
    .option('-t, --tracker <tracker>', 'Set the tracker', 'Task')
    .option(
      '-p, --parent-issue [parent issue]',
      'Set the parent issue',
      parseInt,
    )
    .option('-s, --status <status>', 'Set the status', 'New')
    .option('-r, --release <release>', 'Set the target release')
    .option('-u, --user <user>', 'Assign to the specified user')
    .option('--me', 'Assign to me')
    .action(newCommand)

  program
    .command('take <issue> [user]')
    .alias('t')
    .description('assign yourself or someone else to an issue')
    .option('-s, --status <status>', 'Set the status', 'In Progress')
    .option('--skip-status', "Don't set the status")
    .option('--show', 'Show the issue after taking it')
    .action(takeCommand)

  program
    .command('finish <issue>')
    .alias('f')
    .description('set the status of an issue')
    .option('-s, --status <status>', 'Status to set', 'Resolved')
    .option('-u, --user <user>', 'Assign to the specified user')
    .option('--me', 'Assign to me')
    .action(finishCommand)

  program
    .command('edit <issue>')
    .alias('e')
    .description('edit an issue')
    .option('-T, --title <title>', 'Set the title')
    .option(
      '-d, --description [description]',
      'Set the description, or open an editor if no value is passed',
    )
    .option(
      '-D, --idescription [description]',
      'Set the description, or open an editor if no value is passed',
    )
    .option('-t, --tracker <tracker>', 'Set the tracker')
    .option(
      '-p, --parent-issue [parent issue]',
      'Set the parent issue',
      parseInt,
    )
    .option('-s, --status <status>', 'Set the status')
    .option('-r, --release <release>', 'Set the target release')
    .option('-u, --user <user>', 'Assign to the specified user')
    .option('--me', 'Assign to me')
    .action(editCommand)

  program.parse(process.argv)

  async function listCommand({
    parent: {optsObj: appOptions},
    parentIssue,
    status: statusesJoined,
    release: releasesJoined,
    user,
    me,
    sort,
    group,
    optsObj,
  }) {
    // .action((a) => {
    //   console.log('a', a)
    //   const {parent: {safeOpts: appOptions}, safeOpts: {description, parent, status, user, me}} = a
    debug('optsObj', optsObj)
    const url = projectUrl(config, appOptions)
    if (me !== undefined) {
      user = whois(config)
    }
    user = expandMe(config, user)

    const allIssues = await fetchAll<Issue>(`${url}/issues.json`, 'issues')

    const issues = allIssues.filter(
      i =>
        compare(parentIssue, i.parent) &&
        compare(statusesJoined, i.status) &&
        compare(releasesJoined, i.fixed_version) &&
        compare(user, i.assigned_to),
    )

    if (sort !== undefined) {
      if (sort === 'status') {
        issues.sort(
          (a, b) => a.status.id - b.status.id || b.priority.id - a.priority.id,
        )
      } else if (sort === 'id') {
        issues.sort((a, b) => a.id - b.id)
      }
    }

    if (group) {
      const issuesById = collect(issue => [issue.id, issue], allIssues)
      const groups = pipeValue(
        issues,
        filter(issue => !!issue.parent),
        collect(issue => [issue.parent!.id, [issue]], {
          merge: (a, b) => [...a, ...b],
        }),
      )
      for (const [parentId, issues] of groups) {
        const parent = issuesById.get(parentId)!
        console.log()
        console.log(parent.subject)
        for (const issue of issues) {
          const status = issue.status.name.padEnd(12, ' ')
          const id = issue.id
          const title = issue.subject
          let row = `  ${status} #${id} ${title}`
          if (issue.priority.id <= 3) {
            row = chalk.dim(row)
          }
          if (issue.priority.id == 5) {
            row = chalk.yellow(row)
          }
          if (issue.priority.id >= 6) {
            row = chalk.red(row)
          }
          console.log(row)
        }
      }
    } else {
      issues.forEach(issue => {
        const status = issue.status.name.padEnd(12, ' ')
        const id = issue.id
        const title = issue.subject
        let row = `${status} #${id} ${title}`
        if (issue.priority.id <= 3) {
          row = chalk.dim(row)
        }
        if (issue.priority.id == 5) {
          row = chalk.yellow(row)
        }
        if (issue.priority.id >= 6) {
          row = chalk.red(row)
        }
        console.log(row)
      })
    }
  }

  async function openCommand(issueId, {parent: {optsObj: appOptions}}) {
    const surl = webUrl(config, appOptions)
    issueId = +issueId
    if (isNaN(issueId)) {
      console.error(`Invalid issue ${issueId}`)
      process.exit(1)
    }
    open(`${surl}/issues/${issueId}`)
  }

  async function showCommand(issueId, {parent: {optsObj: appOptions}}) {
    const surl = serverUrl(config, appOptions)
    issueId = +issueId
    if (isNaN(issueId)) {
      console.error(`Invalid issue ${issueId}`)
      process.exit(1)
    }
    const {issue} = await get<{issue: Issue}>(`${surl}/issues/${issueId}.json`)

    console.log(`${issue.tracker.name} #${issue.id}`)
    console.log(`${issue.subject}`)
    console.log()
    console.log(`Status: ${issue.status.name}`)
    console.log(`Priority: ${issue.priority.name}`)
    console.log(`Assignee: ${issue.assigned_to ? issue.assigned_to.name : '-'}`)
    console.log()
    console.log(`${issue.description}`)
  }

  async function newCommand(
    title,
    {
      parent: {optsObj: appOptions},
      description,
      idescription = description,
      parentIssue,
      tracker: trackerName,
      status: statusName,
      release: releaseName,
      user: userName,
      me,
    },
  ) {
    description = idescription
    // .action((title, {parent: {safeOpts: appOptions}, safeOpts: {description, parent, status, user, me}}) => {
    if (typeof description !== 'string') description = undefined
    const surl = serverUrl(config, appOptions)
    const url = projectUrl(config, appOptions)
    if (me !== undefined) {
      userName = whois(config)
    }
    userName = expandMe(config, userName)

    const project = await get(`${url}.json`)
    const tracker = await getTracker(surl, trackerName)
    const status = await getStatus(surl, statusName)

    if (description === true) {
      description = await openInEditor(
        config,
        'Enter the issue description',
        '',
      )
    }

    if (
      parentIssue === true ||
      (parentIssue === undefined && config.requireParent)
    ) {
      parentIssue = await selectParentIssue(url)
    }

    const body: IssueBody = {
      project_id: project.project.id,
      tracker_id: tracker.id,
      status_id: status.id,
      subject: title,
      description,
      parent_issue_id: parentIssue,
    }

    if (releaseName !== undefined) {
      const release = await getRelease(url, releaseName)
      body.fixed_version_id = release.id
    }

    if (userName !== undefined) {
      const user = await getUser(url, userName)
      body.assigned_to_id = user.id
    }

    debug('new body', body)

    const response = await fetch(`${url}/issues.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({issue: body}),
    })

    if (response.status === 201) {
      const body = await response.json()
      const id = body.issue.id
      const url = `${webUrl(config, appOptions)}/issues/${id}`
      console.log(`Created issue #${id} ${url}`)
    } else {
      debug('response status', response.status)
      debug('response text', await response.text())
    }
  }

  async function takeCommand(
    issueId,
    userName = 'me',
    {parent: {optsObj: appOptions}, status: statusName, skipStatus, show},
  ) {
    const surl = serverUrl(config, appOptions)
    const url = projectUrl(config, appOptions)
    userName = expandMe(config, userName)

    const user = await getUser(url, userName)

    const body: Partial<IssueBody> = {assigned_to_id: user.id}

    if (!skipStatus) {
      const status = await getStatus(surl, statusName)
      body.status_id = status.id
    }

    debug('body', body)
    debug('put', `${surl}/issues/${issueId}.json`)

    const response = await fetch(`${surl}/issues/${issueId}.json`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({issue: body}),
    })

    debug('response status', response.status)
    debug('response text', await response.text())

    if (show) {
      await showCommand(issueId, {parent: {optsObj: appOptions}})
    }
  }

  async function finishCommand(
    issue,
    {parent: {optsObj: appOptions}, status: statusName, user: userName, me},
  ) {
    const surl = serverUrl(config, appOptions)
    const url = projectUrl(config, appOptions)
    if (me !== undefined) {
      userName = whois(config)
    }
    userName = expandMe(config, userName)

    const status = await getStatus(surl, statusName)

    const body: Partial<IssueBody> = {status_id: status.id}

    if (userName !== undefined) {
      const user = await getUser(url, userName)
      body.assigned_to_id = user.id
    }

    debug('body', body)
    debug('put', `${surl}/issues/${issue}.json`)

    const response = await fetch(`${surl}/issues/${issue}.json`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({issue: body}),
    })

    debug('response status', response.status)
    debug('response text', await response.text())
  }

  async function editCommand(
    issue,
    {
      parent: {optsObj: appOptions},
      title,
      description,
      idescription = description,
      parentIssue,
      tracker: trackerName,
      status: statusName,
      release: releaseName,
      user: userName,
      me,
    },
  ) {
    description = idescription
    if (typeof description === 'function') description = undefined
    const surl = serverUrl(config, appOptions)
    const url = projectUrl(config, appOptions)
    if (me !== undefined) {
      userName = whois(config)
    }
    userName = expandMe(config, userName)

    if (description === true) {
      const {issue: oldIssue} = await get<{issue: Issue}>(
        `${surl}/issues/${issue}.json`,
      )
      description = await openInEditor(
        config,
        'Enter the issue description',
        `; ${oldIssue.tracker.name} #${oldIssue.id}
; ${oldIssue.subject}
;
${oldIssue.description}`,
      )
    }

    if (parentIssue === true) {
      parentIssue = await selectParentIssue(url)
    }

    const body: Partial<IssueBody> = {
      subject: title,
      description,
      parent_issue_id: parentIssue,
    }

    if (trackerName !== undefined) {
      const tracker = await getTracker(surl, trackerName)
      body.tracker_id = tracker.id
    }

    if (statusName !== undefined) {
      const status = await getStatus(surl, statusName)
      body.status_id = status.id
    }

    if (releaseName !== undefined) {
      const release = await getRelease(url, releaseName)
      body.fixed_version_id = release.id
    }

    if (userName !== undefined) {
      const user = await getUser(url, userName)
      body.assigned_to_id = user.id
    }

    debug('body', body)
    debug('put', `${surl}/issues/${issue}.json`)

    const response = await fetch(`${surl}/issues/${issue}.json`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({issue: body}),
    })

    debug('response status', response.status)
    debug('response text', await response.text())
  }
}

main()
