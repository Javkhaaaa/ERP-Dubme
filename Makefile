SHELL := /bin/bash

BACKEND_DIR := dubme-backend
FRONTEND_DIR := dubme-frontend

.PHONY: help install install-backend install-frontend setup-env db-generate db-migrate db-studio dev dev-backend dev-frontend build build-backend build-frontend start-backend start-frontend lint clean

help:
	@echo "Available targets:"
	@echo "  make install           Install dependencies for backend and frontend"
	@echo "  make setup-env         Create missing local env files from examples"
	@echo "  make db-generate       Run Prisma generate in backend"
	@echo "  make db-migrate        Run Prisma migrations in backend"
	@echo "  make db-studio         Open Prisma Studio in backend"
	@echo "  make dev               Run backend and frontend dev servers together"
	@echo "  make dev-backend       Run backend dev server"
	@echo "  make dev-frontend      Run frontend dev server"
	@echo "  make build             Build backend and frontend"
	@echo "  make build-backend     Build backend"
	@echo "  make build-frontend    Build frontend"
	@echo "  make start-backend     Start backend production server"
	@echo "  make start-frontend    Start frontend production server"
	@echo "  make lint              Run frontend lint"
	@echo "  make clean             Remove build output"

install: install-backend install-frontend

install-backend:
	yarn --cwd $(BACKEND_DIR) install

install-frontend:
	yarn --cwd $(FRONTEND_DIR) install

setup-env:
	@if [ ! -f $(BACKEND_DIR)/.env ]; then cp $(BACKEND_DIR)/.env.example $(BACKEND_DIR)/.env; fi
	@if [ ! -f $(FRONTEND_DIR)/.env.local ]; then cp $(FRONTEND_DIR)/.env.example $(FRONTEND_DIR)/.env.local; fi

db-generate:
	yarn --cwd $(BACKEND_DIR) db:generate

db-migrate:
	yarn --cwd $(BACKEND_DIR) db:migrate

db-studio:
	yarn --cwd $(BACKEND_DIR) db:studio

dev:
	@trap 'kill 0' EXIT; \
	yarn --cwd $(BACKEND_DIR) dev & \
	yarn --cwd $(FRONTEND_DIR) dev & \
	wait

dev-backend:
	yarn --cwd $(BACKEND_DIR) dev

dev-frontend:
	yarn --cwd $(FRONTEND_DIR) dev

build: build-backend build-frontend

build-backend:
	yarn --cwd $(BACKEND_DIR) build

build-frontend:
	yarn --cwd $(FRONTEND_DIR) build

start-backend:
	yarn --cwd $(BACKEND_DIR) start

start-frontend:
	yarn --cwd $(FRONTEND_DIR) start

lint:
	yarn --cwd $(FRONTEND_DIR) lint

clean:
	rm -rf $(BACKEND_DIR)/dist $(FRONTEND_DIR)/.next
