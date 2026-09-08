# Imagen base: Node.js ya instalado, versión ligera (alpine)
FROM node:20-alpine

# Carpeta de trabajo dentro del contenedor
WORKDIR /app

COPY package*.json ./
RUN npm install

# Ahora sí copiamos el resto del proyecto
COPY . .

# El puerto que usa Vite por defecto
EXPOSE 5173

# --host hace que el servidor escuche en 0.0.0.0 en vez de solo
# localhost — necesario para que sea visible DESDE FUERA del contenedor
CMD ["npm", "run", "dev", "--", "--host"]
