FROM maven:3.9.9-eclipse-temurin-17 AS build
WORKDIR /workspace
COPY pom.xml .
COPY src ./src
RUN mvn -q -DskipTests package

FROM eclipse-temurin:17-jre
WORKDIR /app
COPY --from=build /workspace/target/remote-control-0.1.0.jar /app/remote-control.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/remote-control.jar"]
