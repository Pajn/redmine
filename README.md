A simple Redmine CLI

## Installation

```
yarn global add redmine-command
```

## Usage

```
❯ redmine --help

  Usage: redmine [options] [command]


  Options:

    -v, --version            output the version number
    -S, --server <server>    address to the Redmine server
    -P, --project <project>  project identifier
    -h, --help               output usage information


  Commands:

    list|l [options]                 list open issues
    show|s <issue>                   Display details of an issue
    open|o <issue>                   Open issue in a browser
    new|n [options] <title>          create a new issue
    take|t [options] <issue> [user]  assign yourself or someone else to an issue
    finish|f [options] <issue>       set the status of an issue
    edit|e [options] <issue>         edit an issue
```
