.PHONY: default clean test postgres-test lint install app

ENV := venv
PYTHON_VERSION := "3.12"
SYS_PYTHON ?= "python${PYTHON_VERSION}"
ENV_PYTHON := ${ENV}/bin/python3
SITE_PACKAGES := ${ENV}/lib/python${PYTHON_VERSION}/site-packages

default: test

${ENV_PYTHON}:
	@echo "Creating Python ${PYTHON_VERSION} environment..." >&2
	@${SYS_PYTHON} -m venv ${ENV}
	@${ENV_PYTHON} -m pip install -U pip
	@${ENV_PYTHON} -m pip install -U uv

install: ${ENV_PYTHON}
	@${ENV_PYTHON} -m uv pip install -e .

test_install: install
	@${ENV_PYTHON} -m uv pip install -e .[dev]

test: test_install
	@${ENV_PYTHON} -m pytest apps

lint: ${DEV_REQUIREMENTS}
	@echo "Running ruff..."
	@${ENV_PYTHON} -m ruff check src
	@echo "Running ty..."
	@${ENV_PYTHON} -m ty check src

migrations: ${DEV_REQUIREMENTS}
	@${ENV_PYTHON} python -m backend/manage.py make

build:
	@mkdir -p build/

clean:
	@rm -rf ${ENV}
