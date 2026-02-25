package fr.emse.mines_app_auth_service.repository;

import fr.emse.mines_app_auth_service.model.User;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Optional;
import java.util.UUID;

@Repository
public interface UserRepository extends JpaRepository<User, UUID> {
    Optional<User> findByEmail(String email);
    // Linked accounts are now checked via logic, or we can add a custom query if needed 
    // but usually we look up by attributes returned by OAuth provider (often email)
}
